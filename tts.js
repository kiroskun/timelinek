// /functions/api/tts.js
// 火山引擎豆包 TTS 代理 — V1 endpoint + APP ID 鉴权
// 智能 cluster 选择：根据 voice_type 后缀自动判断

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
    return jsonResp({ error: "缺少 VOLC_TTS_APP_ID" }, 500);
  }
  if (!env.VOLC_TTS_ACCESS_TOKEN) {
    return jsonResp({ error: "缺少 VOLC_TTS_ACCESS_TOKEN" }, 500);
  }

  // ─── 3. 解析客户端请求 ───
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResp({ error: "请求非 JSON" }, 400);
  }

  const text = (body.text || "").trim();
  const voiceType = body.voice_type || "zh_female_vv_uranus_bigtts";
  const speedRatio = typeof body.speed_ratio === "number" ? body.speed_ratio : 1.0;
  const pitchRatio = typeof body.pitch_ratio === "number" ? body.pitch_ratio : 1.0;

  if (!text) return jsonResp({ error: "文本为空" }, 400);
  if (text.length > 1024) return jsonResp({ error: "文本超 1024 字符" }, 400);

  // ─── 4. 智能选 cluster ───
  // _uranus_bigtts / _tob → seed-tts 2.0
  // _mars_bigtts → mars (普通大模型)
  // 其他 → volcano_tts (兜底)
  let cluster = env.VOLC_TTS_CLUSTER || "volcano_tts";
  if (voiceType.includes("_uranus_bigtts") || voiceType.includes("_tob") || voiceType.startsWith("saturn_")) {
    cluster = "volcano_tts"; // Seed-TTS 2.0 共享 volcano_tts cluster
  } else if (voiceType.includes("_mars_bigtts")) {
    cluster = "volcano_tts";
  }
  // 用户显式覆盖
  if (body.cluster) cluster = body.cluster;

  // ─── 5. 调用火山引擎 V1 endpoint ───
  const reqId = crypto.randomUUID();
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

  if (pitchRatio !== 1.0) {
    volcPayload.audio.pitch_ratio = pitchRatio;
  }

  let volcResp;
  try {
    volcResp = await fetch("https://openspeech.bytedance.com/api/v1/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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
        cluster_used: cluster,
        voice_used: voiceType,
      },
      502
    );
  }

  let result;
  try {
    result = await volcResp.json();
  } catch (e) {
    return jsonResp({ error: "解析响应失败：" + e.message }, 502);
  }

  if (result.code !== 3000) {
    return jsonResp(
      {
        error: `TTS 失败：${result.message || "未知"}`,
        code: result.code,
        cluster_used: cluster,
        voice_used: voiceType,
        full: result,
      },
      502
    );
  }

  if (!result.data) {
    return jsonResp({ error: "TTS 返回无音频数据" }, 502);
  }

  const binary = base64ToBytes(result.data);
  return new Response(binary, {
    status: 200,
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "no-cache",
      "X-TTS-Provider": "volcengine-v1",
      "X-TTS-Voice": voiceType,
      "X-TTS-Cluster": cluster,
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
