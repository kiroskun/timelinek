/**
 * Timelinek AI Proxy · Cloudflare Pages Function
 * 路径：/api/ai
 * 部署方式：放在 GitHub 仓库 functions/api/ai.js 后 push，Cloudflare Pages 自动部署
 * 
 * 跟 Worker 版本功能完全一样，但因为是同域调用（timelinek.pages.dev/api/ai），
 * 不会被国内运营商拦截 CORS 预检。
 */

export async function onRequestPost({ request, env }) {
  try {
    // ═══ Step 1: 校验 Supabase JWT ═══
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return Response.json({ error: 'Missing token' }, { status: 401 });
    }
    const token = authHeader.replace('Bearer ', '');

    // 用 Supabase 验证 token
    const userResp = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': env.SUPABASE_ANON_KEY,
      },
    });
    if (!userResp.ok) {
      return Response.json({ error: 'Invalid token' }, { status: 401 });
    }
    const user = await userResp.json();
    const userId = user.id;

    // ═══ Step 2: 白名单校验 ═══
    const allowedIds = (env.ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (allowedIds.length > 0 && !allowedIds.includes(userId)) {
      return Response.json({ error: 'User not allowed' }, { status: 403 });
    }

    // ═══ Step 3: 转发到 DeepSeek ═══
    const body = await request.json();
    const payload = {
      model: 'deepseek-chat',
      temperature: 0.7,
      max_tokens: 2000,
      ...body,
    };

    const deepseekResp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    // 流式转发
    if (payload.stream) {
      return new Response(deepseekResp.body, {
        status: deepseekResp.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // 普通响应
    const data = await deepseekResp.json();
    return Response.json(data, { status: deepseekResp.status });

  } catch (err) {
    return Response.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}

// GET 不允许
export async function onRequestGet() {
  return new Response('Method not allowed. Use POST.', { status: 405 });
}
