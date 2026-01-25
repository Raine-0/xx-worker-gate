# xx-worker-gate

截图的接口字段（SchemeName / CountryCode / PhoneNumber / SignName / TemplateCode / TemplateParam / CodeLength / ValidTime / Interval / CodeType / ReturnVerifyCode / AutoRetry）
对应的是阿里云 **号码认证服务（PNVS / Dypnsapi）** 的：

- `SendSmsVerifyCode`：发送短信验证码
- `CheckSmsVerifyCode`：核验短信验证码

阿里云官方文档强调：  
如果 `TemplateParam` 传 `{"code":"##code##","min":"5"}`，验证码由 API 动态生成，阿里云接口可以校验；  
如果 `TemplateParam` 直接传 `{"code":"123456","min":"5"}`（你自定义验证码），阿里云接口无法校验。  
因此本 Worker 采用：**让阿里云生成验证码 + CheckSmsVerifyCode 校验**。

---

## 0) 先把 AccessKey 做“安全处理”（强烈建议）

你不应该把 AK/SK 发到任何聊天窗口。  
请立刻去阿里云控制台把已经泄露的 AccessKey 禁用/删除，并重新创建一个新的 AccessKey（推荐 RAM 用户，最小权限）。

---

## 1) Cloudflare 侧：创建 KV

Cloudflare Dashboard -> Workers & Pages -> **KV** -> Create namespace  
比如命名：`BIRTHDAY_OTP`

---

## 2) Cloudflare 侧：创建 Worker + 绑定 KV

Workers -> Create Worker  
把 `worker.js` 粘进去后，去 Settings / Variables：

KV bindings：

- Binding name: `OTP_KV`
- Namespace: 选择 `BIRTHDAY_OTP`

---

## 3) 设置 Secrets / Variables（不要硬编码）

必填：

- `PASSPHRASE`：你的密语
- `COOKIE_SECRET`：随机长字符串（>=32位）
- `COOKIE_DOMAIN`：`20070224.xyz`

- `TARGET_PHONE`：xx 的手机号
- `ALIYUN_ACCESS_KEY_ID`
- `ALIYUN_ACCESS_KEY_SECRET`
- `ALIYUN_SIGN_NAME`：你在「赠送签名配置」里选的签名（例如你截图那条）
- `ALIYUN_TEMPLATE_CODE`：你在「赠送模板配置」里选的模板 CODE（例如 100001）

可选：

- `COUNTRY_CODE`：默认 `86`
- `VALID_TIME_SECONDS`：默认 `300`
- `CODE_LENGTH`：默认 `6`
- `CODE_TYPE`：默认 `1`（纯数字）
- `INTERVAL_SECONDS`：默认 `60`
- `AUTH_TTL_DAYS`：默认 `30`
- `SID_TTL_SECONDS`：默认 `900`

---

## 4) 添加 Worker Routes（让两个域名都进入验证页）

Worker -> Triggers -> Routes -> Add route

添加两条：

- `20070224.xyz/*`
- `love-xx.20070224.xyz/*`

> 注意：`*.20070224.xyz/*` 不匹配根域名 apex，所以根域名需要单独加。

---

## 5) 测试建议（按顺序）

1. 用无痕打开 `https://20070224.xyz`  
   - 看到密语入口
2. 点“仅访问模式（脱敏）”  
   - 看到脱敏骨架页（不加载任何真实图片/私密内容）
3. 回到 `/__gate` 输入密语  
   - 返回“验证码已发送”
4. 输入短信验证码  
   - 通过后会跳到你原本 Pages 的完整版页面

---

## 6) 常见问题

### Q1：验证码输入正确但仍提示失败
- `CheckSmsVerifyCode` 接口调用成功（Code=OK）并不代表核验成功，核验结果看 `Model.VerifyResult` 是否为 `PASS`。

### Q2：收不到短信
- 是否触发了频控/天级流控（接口本身有 Interval + 日限额）
- `ALIYUN_SIGN_NAME` 与 `ALIYUN_TEMPLATE_CODE` 是否来自“赠送签名/赠送模板”并匹配
- 号码认证服务是否已开通“短信认证”功能

---

祝你给 xx 的生日惊喜成功！
