/**
 * Cloudflare Worker 网关（阿里云 号码认证服务 PNVS / Dypnsapi）
 *
 * 需求：
 * - 20070224.xyz 与 love-xx.20070224.xyz 都访问同一验证入口
 * - 密语正确 -> 调用阿里云 Dypnsapi 的 SendSmsVerifyCode（系统生成验证码）发送短信
 * - 用户输入验证码 -> 调用 CheckSmsVerifyCode 校验，通过后放行到你现有的 Cloudflare Pages 站点（完整版）
 * - “仅访问模式” -> 脱敏骨架页（不代理到 Pages，不加载任何真实照片/私密文案）
 *
 * 重要：阿里云文档明确说明：
 * - TemplateParam 里用 {"code":"##code##",...} 时验证码由 API 动态生成，阿里云接口可完成校验；
 * - 如果 TemplateParam 直接传 {"code":"123456",...}（你自定义验证码），阿里云接口无法校验。
 * 因此这里采用：让阿里云生成验证码 + CheckSmsVerifyCode 校验。
 *
 * 你需要在 Cloudflare Worker 里配置：
 * 1) KV 命名空间（用于保存“已通过密语”的短会话 sid + 简单限流）
 *    - 绑定名：OTP_KV
 *
 * 2) Secrets / Variables（不要写死在代码里）
 *    - PASSPHRASE                 你的密语（中英文都可以）
 *    - COOKIE_SECRET              随机长字符串（>=32位），用于签名 Cookie
 *    - COOKIE_DOMAIN              20070224.xyz （让根域名和子域名共享 Cookie）
 *
 *    - TARGET_PHONE               接收验证码的手机号（xx 的手机号）
 *    - ALIYUN_ACCESS_KEY_ID
 *    - ALIYUN_ACCESS_KEY_SECRET
 *
 *    - ALIYUN_SIGN_NAME           赠送签名（在号码认证服务控制台里选的那条）
 *    - ALIYUN_TEMPLATE_CODE       赠送模板 CODE（在控制台里选的那条）
 *
 * 3) 可选参数（不填有默认值）
 *    - COUNTRY_CODE               默认 86（阿里云短信认证当前也仅支持国内号码）
 *    - VALID_TIME_SECONDS         默认 300（5分钟）
 *    - CODE_LENGTH                默认 6
 *    - CODE_TYPE                  默认 1（纯数字）
 *    - INTERVAL_SECONDS           默认 60（频控）
 *    - AUTH_TTL_DAYS              默认 30（验证成功后免登录天数）
 *    - SID_TTL_SECONDS            默认 900（密语通过到验证码校验的窗口期，秒）
 *
 * 部署提示：
 * - 先确保 Pages 自定义域名已绑定成功（证书已生效），再加 Worker Routes，避免影响 .well-known/acme-challenge。
 */

const DEFAULTS = {
  COUNTRY_CODE: "86",
  VALID_TIME_SECONDS: 300,
  CODE_LENGTH: 6,
  CODE_TYPE: 1,
  INTERVAL_SECONDS: 60,
  AUTH_TTL_DAYS: 30,
  SID_TTL_SECONDS: 900,
  SMS_COOLDOWN_SECONDS: 60,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 证书校验放行（更稳：不影响 Pages 自定义域名签发/续签）
    if (path.startsWith("/.well-known/acme-challenge/")) {
      return fetch(request);
    }

    // 内部页面/模式
    if (path === "/__public" && request.method === "GET") return enterPublicMode(env);
    if (path === "/__gate" && request.method === "GET") return gatePage(env, { clearPublic: true });
    if (path === "/__logout" && request.method === "GET") return logout(env);

    // API
    if (path === "/api/start" && request.method === "POST") return apiStart(request, env);
    if (path === "/api/verify" && request.method === "POST") return apiVerify(request, env);

    // 已解锁 -> 放行到 Pages（完整版）
    const cookies = parseCookies(request.headers.get("Cookie") || "");
    const auth = cookies["cf_auth"];
    if (auth && await verifyAuthCookie(auth, env)) {
      return fetch(request);
    }

    // 仅访问模式 -> 永远返回脱敏骨架页（不代理到 Pages）
    if (cookies["cf_mode"] === "public") {
      return publicSkeletonPage(url);
    }

    // 默认 -> 验证入口
    return gatePage(env);
  },
};

// ----------------------- 页面：验证入口 -----------------------

function gatePage(env, { clearPublic = false } = {}) {
  const title = "⭐️ Just for xx";
  const subtitle = "如果你知道密语，就解锁并接收短信验证码。否则也可以进入仅访问模式（不含任何个人信息）。";

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root{--bg:#0b0c10;--card:#131622;--txt:#eef1f8;--muted:#9aa3b2;--line:rgba(255,255,255,.12);--accent:#8ec5ff;--accent-2:#b28dff;--btn:#f9f9fb;--btnTxt:#0f1117;}
    *{box-sizing:border-box;}
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(1200px 600px at 18% 12%, rgba(142,197,255,.16), transparent),radial-gradient(900px 600px at 80% 0%, rgba(178,141,255,.16), transparent),var(--bg);font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:var(--txt);}
    .card{width:min(560px,92vw);background:linear-gradient(180deg, rgba(255,255,255,.03), transparent),var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:0 30px 80px rgba(0,0,0,.55);padding:26px 22px;position:relative;overflow:hidden;}
    .card::after{content:"";position:absolute;inset:0;border-radius:20px;border:1px solid rgba(255,255,255,.06);pointer-events:none;}
    h1{margin:0 0 8px;font-size:22px;letter-spacing:.3px;color:var(--txt);font-family:"Playfair Display","Times New Roman",serif;}
    p{margin:0 0 16px;line-height:1.7;color:var(--muted);font-size:14px;}
    label{display:block;color:var(--muted);font-size:13px;margin:12px 0 8px;}
    input{width:100%;padding:13px 14px;border-radius:14px;border:1px solid transparent;background:#0e1118;color:var(--txt);font-size:16px;outline:none;box-shadow:inset 0 0 0 1px var(--line);}
    input::placeholder{color:rgba(255,255,255,.35);}
    input:focus{box-shadow:0 0 0 3px rgba(142,197,255,.2), inset 0 0 0 1px rgba(142,197,255,.55);}
    button{margin-top:14px;width:100%;padding:12px 14px;border-radius:14px;border:0;background:linear-gradient(135deg, var(--btn), #e6f1ff);color:var(--btnTxt);font-size:16px;cursor:pointer;font-weight:700;transition:transform .15s ease, box-shadow .15s ease;}
    button:hover{transform:translateY(-1px);box-shadow:0 12px 24px rgba(120,170,255,.2);}
    button:disabled{opacity:.6;cursor:not-allowed;transform:none;box-shadow:none;}
    .row{display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap}
    .row.center{justify-content:center;}
    .clear-link{position:absolute;top:14px;left:14px;font-size:11px;color:rgba(255,255,255,.6);text-decoration:none;}
    .clear-link:hover{text-decoration:underline;color:#dbe6ff;}
    .link{color:#c9d4ff;text-decoration:none;font-size:13px;}
    .link:hover{text-decoration:underline;}
    .err{color:#ff8585;margin:10px 0 0;font-size:13px;}
    .ok{color:#8bffc2;margin:10px 0 0;font-size:13px;}
    .otpBox{display:none;margin-top:18px;padding-top:14px;border-top:1px dashed var(--line);}
    .fine{margin-top:10px;font-size:12px;color:rgba(255,255,255,.55);}
    .badge{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:999px;background:rgba(142,197,255,.12);color:#cfe4ff;font-size:12px;border:1px solid rgba(142,197,255,.25);}
  </style>
</head>
<body>
  <div class="card">
    <a class="clear-link" href="/__logout">清除状态</a>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(subtitle)}</p>

    <div id="stage1">
      <div class="badge">双重验证 · 安全访问</div>
      <label>我是？</label>
      <input id="phrase" placeholder="输入密语…" autocomplete="off" />
      <button id="btnStart">解锁并发送验证码</button>
      <div class="row center">
        <a class="link" href="/__public">仅访问模式（脱敏）</a>
      </div>
      <div id="msg1" class=""></div>
    </div>

    <div class="otpBox" id="stage2">
      <p style="margin:0 0 10px;color:var(--txt)">✅ 密语正确，验证码已发送到预设手机号。</p>
      <label>短信验证码（4~8 位，通常 6 位）</label>
      <input id="code" inputmode="numeric" placeholder="例如：123456" maxlength="8" />
      <button id="btnVerify">验证并进入</button>
      <div id="msg2" class=""></div>
      <div class="row">
        <a class="link" href="/__gate">返回密语页</a>
      </div>
      <div class="fine">如果收不到短信：检查「赠送签名/赠送模板」是否选择正确、是否触发频控/天级流控等。</div>
    </div>

  </div>

<script>
const $ = (id)=>document.getElementById(id);
function setMsg(el, type, text){
  el.className = type;
  el.textContent = text || "";
}
$("btnStart").addEventListener("click", async ()=>{
  const phrase = $("phrase").value || "";
  $("btnStart").disabled = true;
  setMsg($("msg1"), "", "");
  try{
    const r = await fetch("/api/start", {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({ phrase })
    });
    const j = await r.json();
    if(!r.ok){
      setMsg($("msg1"), "err", j.message || "失败了");
      return;
    }
    setMsg($("msg1"), "ok", j.message || "验证码已发送");
    $("stage2").style.display = "block";
    $("code").focus();
  }catch(e){
    setMsg($("msg1"), "err", "网络错误，请稍后重试");
  }finally{
    $("btnStart").disabled = false;
  }
});

$("btnVerify").addEventListener("click", async ()=>{
  const code = ($("code").value || "").trim();
  $("btnVerify").disabled = true;
  setMsg($("msg2"), "", "");
  try{
    const r = await fetch("/api/verify", {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({ code })
    });
    const j = await r.json();
    if(!r.ok){
      setMsg($("msg2"), "err", j.message || "验证码错误");
      return;
    }
    setMsg($("msg2"), "ok", j.message || "验证成功，正在进入…");
    setTimeout(()=>location.href="/", 600);
  }catch(e){
    setMsg($("msg2"), "err", "网络错误，请稍后重试");
  }finally{
    $("btnVerify").disabled = false;
  }
});
</script>
</body>
</html>`;

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });

  if (clearPublic) {
    headers.append("set-cookie", cookie("cf_mode", "", { maxAge: 0, domain: env.COOKIE_DOMAIN }));
  }

  return new Response(html, { headers });
}

// ----------------------- 页面：仅访问模式（脱敏骨架页） -----------------------

function publicSkeletonPage(url) {
  const host = url.hostname;
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>🫧 仅访问模式（脱敏）</title>
  <style>
    :root{--bg:#0b0c10;--card:#131622;--txt:#eef1f8;--muted:#9aa3b2;--line:rgba(255,255,255,.12);--accent:#8ec5ff;}
    *{box-sizing:border-box;}
    body{margin:0;min-height:100vh;background:radial-gradient(1200px 600px at 70% 10%, rgba(142,197,255,.12), transparent),radial-gradient(900px 500px at 20% 0%, rgba(178,141,255,.12), transparent), var(--bg);font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;color:var(--txt);}
    .wrap{width:min(980px,94vw);margin:30px auto 56px;}
    .top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap;}
    .tag{font-size:12px;color:rgba(255,255,255,.7);border:1px solid var(--line);padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.03);}
    a{color:#c9d4ff;text-decoration:none;}
    a:hover{text-decoration:underline;}
    .hero{background:linear-gradient(180deg, rgba(255,255,255,.03), transparent),var(--card);border:1px solid var(--line);border-radius:20px;padding:20px;margin-bottom:16px;box-shadow:0 20px 50px rgba(0,0,0,.4);}
    h1{margin:0 0 8px;font-size:22px;letter-spacing:.3px;}
    p{margin:0;color:var(--muted);line-height:1.7;}
    .grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px;margin-top:12px;}
    .sec{grid-column:span 12;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:16px;}
    @media(min-width:860px){
      .sec.half{grid-column:span 6;}
      .sec.third{grid-column:span 4;}
    }
    .ph{margin-top:10px;border-radius:14px;border:1px dashed var(--line);background:rgba(255,255,255,.03);padding:12px;color:rgba(255,255,255,.55);font-size:13px;line-height:1.7;}
    .bar{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;}
    .chip{font-size:12px;color:rgba(255,255,255,.75);border:1px solid var(--line);padding:6px 10px;border-radius:999px;background:rgba(255,255,255,.03);}
    footer{margin-top:18px;color:rgba(255,255,255,.45);font-size:12px;}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="tag">仅访问模式（已脱敏） · ${escapeHtml(host)}</div>
      <div class="tag"><a href="/__gate">我是 xx，去解锁</a></div>
    </div>

    <div class="hero">
      <h1>这是网站的“总体框架预览”</h1>
      <p>你现在看到的是不含任何个人信息的版本：不展示名字、在一起时间、照片、私密文案等，但会展示“这个网站由哪些模块组成”。</p>
      <div class="bar">
        <span class="chip">首页/封面</span>
        <span class="chip">倒计时</span>
        <span class="chip">纪念日</span>
        <span class="chip">相册</span>
        <span class="chip">小信/告白</span>
        <span class="chip">彩蛋</span>
        <span class="chip">音乐开关</span>
      </div>
    </div>

    <div class="grid">
      <div class="sec half">
        <h2 style="margin:0 0 6px;font-size:16px;">🎂 生日倒计时模块</h2>
        <div class="ph">（脱敏）这里原本会显示：距离生日还有多少天/小时/分钟。</div>
      </div>
      <div class="sec half">
        <h2 style="margin:0 0 6px;font-size:16px;">💞 纪念日模块</h2>
        <div class="ph">（脱敏）这里原本会显示：在一起的纪念日倒计时/已经在一起多久。</div>
      </div>

      <div class="sec third">
        <h2 style="margin:0 0 6px;font-size:16px;">📷 相册模块</h2>
        <div class="ph">（脱敏）这里原本会展示照片墙（图片已隐藏）。</div>
      </div>
      <div class="sec third">
        <h2 style="margin:0 0 6px;font-size:16px;">✉️ 信封/告白模块</h2>
        <div class="ph">（脱敏）这里原本会展示一段只给她看的文字（内容已隐藏）。</div>
      </div>
      <div class="sec third">
        <h2 style="margin:0 0 6px;font-size:16px;">🪄 彩蛋模块</h2>
        <div class="ph">（脱敏）这里原本会有一个暗号触发的小彩蛋（内容已隐藏）。</div>
      </div>

      <div class="sec">
        <h2 style="margin:0 0 6px;font-size:16px;">🎵 音乐/交互模块</h2>
        <div class="ph">（脱敏）这里原本会有背景音乐开关、轻微动画和互动提示（已隐藏具体资源）。</div>
      </div>
    </div>

    <footer>
      <div>如果你是 xx，请点击右上角「我是 xx，去解锁」输入密语后获取短信验证码。</div>
      <div>提示：为了隐私安全，这个模式不会代理/加载任何真实照片或私密内容。</div>
    </footer>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// ----------------------- API：start（密语正确 -> 发送短信验证码） -----------------------

async function apiStart(request, env) {
  const cfg = getCfg(env);
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

  // Body
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const phrase = (body.phrase || "").toString();

  // 粗略限流：密语尝试（10分钟 20次）
  const pwKey = `rl:pw:${ip}`;
  const pwCount = await bumpCounter(env, pwKey, 10 * 60);
  if (pwCount > 20) return json({ ok: false, message: "尝试次数过多，请稍后再试。" }, 429);

  if (!env.PASSPHRASE || phrase !== env.PASSPHRASE) {
    return json({ ok: false, message: "密语不对哦～" }, 401);
  }

  // 发送冷却（本地层面再控一次，防止有人刷你短信额度）
  const coolKey = `rl:sms:${ip}`;
  const now = Date.now();
  const last = await env.OTP_KV.get(coolKey);
  if (last && now - Number(last) < cfg.SMS_COOLDOWN_SECONDS * 1000) {
    return json({ ok: false, message: "操作太快啦，稍等一会再试～" }, 429);
  }

  // sid：用于绑定“已通过密语”的短会话
  const sid = crypto.randomUUID();
  await env.OTP_KV.put(`sid:${sid}`, JSON.stringify({ ok: true, ts: now }), { expirationTtl: cfg.SID_TTL_SECONDS });

  // 调用阿里云：SendSmsVerifyCode
  const min = String(Math.max(1, Math.ceil(cfg.VALID_TIME_SECONDS / 60)));
  const templateParam = JSON.stringify({ code: "##code##", min });

  const sendParams = {
    PhoneNumber: env.TARGET_PHONE,
    CountryCode: cfg.COUNTRY_CODE,
    SignName: env.ALIYUN_SIGN_NAME,
    TemplateCode: env.ALIYUN_TEMPLATE_CODE,
    TemplateParam: templateParam,
    CodeLength: String(cfg.CODE_LENGTH),
    ValidTime: String(cfg.VALID_TIME_SECONDS),
    Interval: String(cfg.INTERVAL_SECONDS),
    CodeType: String(cfg.CODE_TYPE),
    ReturnVerifyCode: "false",
    AutoRetry: "1",
  };

  const sendResp = await aliyunCall(env, "SendSmsVerifyCode", sendParams);
  if (!sendResp.ok) {
    return json({ ok: false, message: `短信发送失败：${sendResp.message}` }, 502);
  }

  // 写冷却
  await env.OTP_KV.put(coolKey, String(now), { expirationTtl: 10 * 60 });

  // 设置 sid cookie（让前端进入验证码页；并用于 verify）
  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("set-cookie", cookie("cf_sid", sid, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: cfg.SID_TTL_SECONDS,
    domain: env.COOKIE_DOMAIN,
  }));
  // 清 public 模式
  headers.append("set-cookie", cookie("cf_mode", "", { maxAge: 0, domain: env.COOKIE_DOMAIN }));

  return json({ ok: true, message: "验证码已发送，请查收短信。" }, 200, headers);
}

// ----------------------- API：verify（调用 CheckSmsVerifyCode 校验） -----------------------

async function apiVerify(request, env) {
  const cfg = getCfg(env);
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const sid = cookies["cf_sid"];
  if (!sid) return json({ ok: false, message: "缺少会话信息，请返回重新解锁。" }, 400);

  const sidState = await env.OTP_KV.get(`sid:${sid}`);
  if (!sidState) return json({ ok: false, message: "会话已过期，请重新解锁获取验证码。" }, 410);

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const code = (body.code || "").toString().trim();
  if (!/^[0-9A-Za-z]{4,8}$/.test(code)) {
    return json({ ok: false, message: "请输入正确的验证码（4~8位）。" }, 400);
  }

  // 调用阿里云：CheckSmsVerifyCode
  const verifyParams = {
    PhoneNumber: env.TARGET_PHONE,
    CountryCode: cfg.COUNTRY_CODE,
    VerifyCode: code,
    CaseAuthPolicy: "1",
  };

  const checkResp = await aliyunCall(env, "CheckSmsVerifyCode", verifyParams);
  if (!checkResp.ok) {
    return json({ ok: false, message: `核验失败：${checkResp.message}` }, 502);
  }

  // 注意：API 调用成功（Code=OK）不等于核验成功，要看 Model.VerifyResult
  const verifyResult = checkResp.data?.Model?.VerifyResult;
  if (verifyResult !== "PASS") {
    return json({ ok: false, message: "验证码不对或已过期，再试一次～" }, 401);
  }

  // 成功：删 sid
  await env.OTP_KV.delete(`sid:${sid}`);

  // 设置授权 cookie（30天）
  const ts = Date.now();
  const token = await signAuthToken(env, ts);

  const headers = new Headers({ "cache-control": "no-store" });
  headers.append("set-cookie", cookie("cf_auth", token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: cfg.AUTH_TTL_DAYS * 24 * 3600,
    domain: env.COOKIE_DOMAIN,
  }));
  // 清 sid
  headers.append("set-cookie", cookie("cf_sid", "", { maxAge: 0, domain: env.COOKIE_DOMAIN }));

  return json({ ok: true, message: "验证成功！欢迎进入～" }, 200, headers);
}

// ----------------------- 模式切换 -----------------------

function enterPublicMode(env) {
  const headers = new Headers({ "cache-control": "no-store", "location": "/" });
  headers.append("set-cookie", cookie("cf_mode", "public", {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 7 * 24 * 3600,
    domain: env.COOKIE_DOMAIN,
  }));
  // 清掉其他状态
  headers.append("set-cookie", cookie("cf_sid", "", { maxAge: 0, domain: env.COOKIE_DOMAIN }));
  headers.append("set-cookie", cookie("cf_auth", "", { maxAge: 0, domain: env.COOKIE_DOMAIN }));
  return new Response(null, { status: 302, headers });
}

function logout(env) {
  const headers = new Headers({ "cache-control": "no-store", "location": "/__gate" });
  headers.append("set-cookie", cookie("cf_auth", "", { maxAge: 0, domain: env.COOKIE_DOMAIN }));
  headers.append("set-cookie", cookie("cf_sid", "", { maxAge: 0, domain: env.COOKIE_DOMAIN }));
  headers.append("set-cookie", cookie("cf_mode", "", { maxAge: 0, domain: env.COOKIE_DOMAIN }));
  return new Response(null, { status: 302, headers });
}

// ----------------------- Cookie 签名（放行完整版） -----------------------

async function signAuthToken(env, ts) {
  const msg = `full.${ts}`;
  const sig = await hmacSha256Hex(env.COOKIE_SECRET, msg);
  return `${ts}.${sig}`;
}

async function verifyAuthCookie(token, env) {
  try {
    const [tsStr, sig] = token.split(".");
    const ts = Number(tsStr);
    if (!Number.isFinite(ts) || !sig) return false;

    const cfg = getCfg(env);
    const maxAgeMs = cfg.AUTH_TTL_DAYS * 24 * 3600 * 1000;
    if (Date.now() - ts > maxAgeMs) return false;

    const expected = await hmacSha256Hex(env.COOKIE_SECRET, `full.${tsStr}`);
    return timingSafeEqual(sig, expected);
  } catch {
    return false;
  }
}

// ----------------------- 阿里云 OpenAPI：ACS3-HMAC-SHA256 -----------------------

async function aliyunCall(env, action, queryParams) {
  // 必填检查
  const required = ["ALIYUN_ACCESS_KEY_ID", "ALIYUN_ACCESS_KEY_SECRET", "ALIYUN_SIGN_NAME", "ALIYUN_TEMPLATE_CODE", "TARGET_PHONE"];
  for (const k of required) {
    if (!env[k]) return { ok: false, message: `缺少环境变量 ${k}` };
  }

  const host = "dypnsapi.aliyuncs.com";
  const version = "2017-05-25";
  const method = "POST";
  const canonicalUri = "/";

  const xAcsDate = iso8601NoMs(new Date());
  const nonce = crypto.randomUUID();
  const payloadHash = await sha256HexBytes(new Uint8Array()); // 空 body

  const headersToSign = {
    "host": host,
    "x-acs-action": action,
    "x-acs-content-sha256": payloadHash,
    "x-acs-date": xAcsDate,
    "x-acs-signature-nonce": nonce,
    "x-acs-version": version,
  };

  const canonicalQueryString = buildCanonicalQueryString(queryParams);
  const { canonicalHeaders, signedHeaders } = buildCanonicalHeaders(headersToSign);

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = `ACS3-HMAC-SHA256\n${hashedCanonicalRequest}`;
  const signature = await hmacSha256Hex(env.ALIYUN_ACCESS_KEY_SECRET, stringToSign);

  const authorization =
    `ACS3-HMAC-SHA256 ` +
    `Credential=${env.ALIYUN_ACCESS_KEY_ID},` +
    `SignedHeaders=${signedHeaders},` +
    `Signature=${signature}`;

  const url = `https://${host}/?${canonicalQueryString}`;
  const reqHeaders = new Headers();
  reqHeaders.set("x-acs-action", action);
  reqHeaders.set("x-acs-version", version);
  reqHeaders.set("x-acs-date", xAcsDate);
  reqHeaders.set("x-acs-signature-nonce", nonce);
  reqHeaders.set("x-acs-content-sha256", payloadHash);
  reqHeaders.set("Authorization", authorization);

  const resp = await fetch(url, { method, headers: reqHeaders });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }

  if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}` };
  // 统一判断：Code=OK & Success=true
  if (data?.Code === "OK" && data?.Success === true) {
    return { ok: true, data };
  }
  return { ok: false, message: data?.Message || data?.Code || "未知错误", data };
}

// --- Canonical helpers ---

function buildCanonicalQueryString(params) {
  const keys = Object.keys(params).sort();
  return keys.map(k => `${percentEncode(k)}=${percentEncode(String(params[k] ?? ""))}`).join("&");
}

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function buildCanonicalHeaders(headers) {
  const keys = Object.keys(headers).map(k => k.toLowerCase()).sort();
  const canonicalHeaders = keys.map(k => `${k}:${String(headers[k]).trim()}\n`).join("");
  const signedHeaders = keys.join(";");
  return { canonicalHeaders, signedHeaders };
}

// ----------------------- 通用工具 -----------------------

function getCfg(env) {
  return {
    COUNTRY_CODE: env.COUNTRY_CODE || DEFAULTS.COUNTRY_CODE,
    VALID_TIME_SECONDS: num(env.VALID_TIME_SECONDS, DEFAULTS.VALID_TIME_SECONDS),
    CODE_LENGTH: num(env.CODE_LENGTH, DEFAULTS.CODE_LENGTH),
    CODE_TYPE: num(env.CODE_TYPE, DEFAULTS.CODE_TYPE),
    INTERVAL_SECONDS: num(env.INTERVAL_SECONDS, DEFAULTS.INTERVAL_SECONDS),
    AUTH_TTL_DAYS: num(env.AUTH_TTL_DAYS, DEFAULTS.AUTH_TTL_DAYS),
    SID_TTL_SECONDS: num(env.SID_TTL_SECONDS, DEFAULTS.SID_TTL_SECONDS),
    SMS_COOLDOWN_SECONDS: num(env.SMS_COOLDOWN_SECONDS, DEFAULTS.SMS_COOLDOWN_SECONDS),
  };
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function json(obj, status = 200, extraHeaders) {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (extraHeaders) {
    for (const [k, v] of extraHeaders.entries()) headers.append(k, v);
  }
  return new Response(JSON.stringify(obj), { status, headers });
}

function cookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || "/"}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite || "Lax"}`);
  return parts.join("; ");
}

function parseCookies(header) {
  const out = {};
  header.split(";").forEach(part => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function iso8601NoMs(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function sha256Hex(str) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return toHex(buf);
}

async function sha256HexBytes(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(buf);
}

async function hmacSha256Hex(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret || ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return toHex(sig);
}

function toHex(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return out === 0;
}

async function bumpCounter(env, key, ttlSeconds) {
  const v = await env.OTP_KV.get(key);
  const n = (v ? Number(v) : 0) + 1;
  await env.OTP_KV.put(key, String(n), { expirationTtl: ttlSeconds });
  return n;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[c]);
}
