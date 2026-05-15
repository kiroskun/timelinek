// /functions/api/tts.js
// 火山引擎豆包 TTS 代理 — 使用 V1 endpoint + 旧版 APP ID 鉴权（最稳定）
//
// 鉴权方式：
//   Authorization: Bearer;{ACCESS_TOKEN}  (注意是分号不是空格)
//   body 含 app.appid / app.token / app.cluster
//
// 客户端调用：
//   POST /api/tts  Authorization: Bearer {supabase_jwt}
//   body: { text, voice_type, speed_ratio, pitch_ratio }
// 返回：MP3 二进制

export async function onRequestPost({ request, env }) {
  // ─── 1. Supabase JWT 鉴权 ───
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return jsonResp({ error: "未授权" }, 401);
  }
  const userToken = auth.slice(7);

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
  if (!env.VOLC_TTS_APP_ID) {
    return jsonResp({ error: "缺少 VOLC_TTS_APP_ID 环境变量" }, 500);
  }
  if (!env.VOLC_TTS_ACCESS_TOKEN) {
    return jsonResp({ error: "缺少 VOLC_TTS_ACCESS_TOKEN 环境变量" }, 500);
  }

  // ─── 3. 解析客户端请求 ───
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

  // ─── 4. 调用火山引擎 V1 endpoint ───
  const reqId = crypto.randomUUID();
  const cluster = env.VOLC_TTS_CLUSTER || "volcano_tts";

  const volcPayload = {
    app: {
      appid: env.VOLC_TTS_APP_ID,
      token: env.VOLC_TTS_ACCESS_TOKEN,
      cluster: cluster,
    },
    user: {
      uid: "timelinek-" + (userToken.slice(0, 8) || "anon"),
    },
    audio: {
      voice_type: voiceType,
      encoding: "mp3",
      speed_ratio: speedRatio,
      rate: 24000,
    },
    request: {
      reqid: reqId,
      text: text,
      operation: "query",
    },
  };

  // pitch_ratio 单独加（大模型 2.0 音色支持）
  if (pitchRatio !== 1.0) {
    volcPayload.audio.pitch_ratio = pitchRatio;
  }

  let volcResp;
  try {
    volcResp = await fetch("https://openspeech.bytedance.com/api/v1/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 注意：火山引擎要求 Bearer; 后面紧接 token，没有空格
        Authorization: `Bearer;${env.VOLC_TTS_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(volcPayload),
    });
  } catch (e) {
    return jsonResp({ error: "网络失败：" + e.message }, 502);
  }

  if (!volcResp.ok) {
    const errText = await volcResp.text().catch(() => "");
    return jsonResp(
      {
        error: `火山引擎 HTTP ${volcResp.status}`,
        detail: errText.slice(0, 500),
      },
      502
    );
  }

  // ─── 5. 解析 V1 响应（JSON 格式，含 base64 audio） ───
  let result;
  try {
    result = await volcResp.json();
  } catch (e) {
    return jsonResp({ error: "解析响应失败：" + e.message }, 502);
  }

  // V1 success code = 3000
  if (result.code !== 3000) {
    return jsonResp(
      {
        error: `TTS 失败：${result.message || "未知"}`,
        code: result.code,
        full: result,
      },
      502
    );
  }

  if (!result.data) {
    return jsonResp({ error: "TTS 返回无音频数据" }, 502);
  }

  // ─── 6. base64 → 二进制 MP3 ───
  const binary = base64ToBytes(result.data);
  return new Response(binary, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-cache",
      "X-TTS-Provider": "volcengine-v1",
      "X-TTS-Voice": voiceType,
      "X-TTS-Bytes": String(binary.length),
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
