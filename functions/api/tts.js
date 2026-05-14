// /functions/api/tts.js
// Cloudflare Pages Function — 火山引擎豆包语音合成 2.0 (新版 API Key 鉴权)
//
// 新版鉴权说明：
//   - 只用 API Key 一个凭证：Authorization: Bearer;{api_key}
//   - Endpoint：V3 单向流式 https://openspeech.bytedance.com/api/v3/tts/unidirectional
//
// 客户端调用：
//   POST /api/tts  Authorization: Bearer {supabase_jwt}
//   body: { text, voice_type, speed_ratio, pitch_ratio }
// 返回：MP3 二进制（直接用 <audio> 播放）

export async function onRequestPost({ request, env }) {
  // ─── 1. 鉴权：必须带 Supabase JWT ───
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return jsonResp({ error: "未授权" }, 401);
  }
  const userToken = auth.slice(7);

  // 轻量校验 Supabase token
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    try {
      const userResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
        headers: {
          Authorization: `Bearer ${userToken}`,
          apikey: env.SUPABASE_ANON_KEY,
        },
      });
      if (!userResp.ok) return jsonResp({ error: "Token 无效" }, 401);
    } catch (e) {
      console.warn("[TTS] Supabase 校验失败，放行:", e.message);
    }
  }

  // ─── 2. 校验环境变量 ───
  if (!env.VOLC_TTS_API_KEY) {
    return jsonResp({ error: "服务未配置：缺少 VOLC_TTS_API_KEY" }, 500);
  }

  // ─── 3. 解析请求 ───
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResp({ error: "请求非 JSON" }, 400);
  }

  const text = (body.text || "").trim();
  const voiceType = body.voice_type || "zh_female_cancan_mars_bigtts";
  const speedRatio = typeof body.speed_ratio === "number" ? body.speed_ratio : 1.0;
  const pitchRatio = typeof body.pitch_ratio === "number" ? body.pitch_ratio : 1.0;

  if (!text) return jsonResp({ error: "文本为空" }, 400);
  if (text.length > 1024) return jsonResp({ error: "文本超 1024 字符" }, 400);

  // ─── 4. 调火山引擎 V3 SSE 流式 ───
  const reqId = crypto.randomUUID();
  const volcPayload = {
    user: { uid: "timelinek-" + (userToken.slice(0, 8) || "anon") },
    req_params: {
      text: text,
      speaker: voiceType,
      audio_params: {
        format: "mp3",
        sample_rate: 24000,
        speech_rate: Math.round((speedRatio - 1) * 100),
        pitch_rate: Math.round((pitchRatio - 1) * 100),
      },
    },
  };

  let volcResp;
  try {
    volcResp = await fetch(
      "https://openspeech.bytedance.com/api/v3/tts/unidirectional",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer;${env.VOLC_TTS_API_KEY}`,
          "X-Api-Request-Id": reqId,
          "X-Api-Resource-Id": "volc.service_type.10029",
          "X-Api-App-Key": env.VOLC_TTS_APP_KEY || "aGjiRDfUWi",
          "X-Api-Access-Key": env.VOLC_TTS_API_KEY,
        },
        body: JSON.stringify(volcPayload),
      }
    );
  } catch (e) {
    return jsonResp({ error: "网络失败：" + e.message }, 502);
  }

  if (!volcResp.ok) {
    const errText = await volcResp.text().catch(() => "");
    return jsonResp(
      { error: `火山引擎 HTTP ${volcResp.status}`, detail: errText.slice(0, 500) },
      502
    );
  }

  // ─── 5. 解析 SSE 流 ───
  const reader = volcResp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const audioChunks = [];
  let errorMsg = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const evt of events) {
        const line = evt.trim();
        if (!line.startsWith("data:")) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;
        try {
          const msg = JSON.parse(dataStr);
          if (msg.code && msg.code !== 0 && msg.code !== 20000000) {
            errorMsg = msg.message || `code ${msg.code}`;
            continue;
          }
          if (msg.data) {
            audioChunks.push(base64ToBytes(msg.data));
          } else if (msg.payload && msg.payload.data) {
            audioChunks.push(base64ToBytes(msg.payload.data));
          }
        } catch (e) {
          console.warn("[TTS] SSE 解析失败:", e.message);
        }
      }
    }
  } catch (e) {
    return jsonResp({ error: "读取流失败：" + e.message }, 502);
  }

  if (errorMsg) return jsonResp({ error: "TTS 失败：" + errorMsg }, 502);
  if (audioChunks.length === 0)
    return jsonResp({ error: "TTS 返回空音频" }, 502);

  // ─── 6. 合并 chunks → MP3 ───
  const totalLen = audioChunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of audioChunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return new Response(merged, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-cache",
      "X-TTS-Provider": "volcengine-v3",
      "X-TTS-Voice": voiceType,
      "X-TTS-Bytes": String(totalLen),
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
