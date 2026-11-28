# A · 委托授权与临时票据 — 调研笔记（DSH account-mesh 设计输入）

- 调研日期：2026-11-28 ｜ 主题：能力式委托（Macaroons/Biscuit/UCAN/ZCAP/SPIFFE）、OAuth 临时授权家族、短口令/邀请码、批量发码运维、离线撤销 ｜ 方法：RFC 原文、厂商文档、论文、公开安全事件报道；行内链接均可访问，汇总见文末。
- 关注场景：主账号 + 无密码子账号（6~10 位口令）、批量发给测试玩家/电台听众的限时门票、托管保险柜 `vault/open` 短期票据；核心约束是**本地优先、离线可用、P2P 无中心服务器**。

## 结论摘要

- **最值得抄 ①：Biscuit/UCAN 式"签发即固定作用域 + 只可追加收窄 + 离线可验"的能力令牌。** 门票写成 `iss/sub/aud/scope[]/exp/nbf/gen/jti/device_jkt`，任何 DSH 节点只凭公钥离线验证；衰减只能加 caveat/block，不能扩权。
- **最值得抄 ②：RFC 9449 DPoP 的发送方约束。** `jti/htm/htu/ath` + `cnf.jkt` 把令牌绑定到终端密钥，口令首次兑换即绑定；之后"转发给别人"的凭证没有私钥就用不了。
- **最值得抄 ③：RFC 8628/GNAP 的两阶段设备授权 + GNAP token 管理面。** 短 `expires_in`、`interval`/`slow_down`、`user_code`、rotate/DELETE 撤销，正好覆盖"陌生终端接入 + 立即踢出"。
- **最该避开的坑 ①：把"手机号与主账号一致"当作提权依据。** 现设计稿的提权路径等于用可被 SIM swap 的标识做授权；[NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) 明确限制 PSTN 认证并要求关注换卡/转网风险，[微软 Storm-2372 处置建议](https://www.microsoft.com/en-us/security/blog/2025/02/13/storm-2372-conducts-device-code-phishing-campaign/)同样建议避免电话类 MFA。
- **最该避开的坑 ②：长期、通用、不可绑定的 bearer 短码。** 6~10 位可读口令只有约 26~43 bit，天然可转发、截图、转卖；Ticketmaster 用 [15 秒轮换码](https://www.mlb.com/padres/tickets/safetix)替代可截图的静态条码，Clubhouse 邀请码被炒到 [闲鱼 400 元 / eBay 97 美元](https://www.yicai.com/news/100939382.html)。

## 0. 场景拆解：四类凭证不要混为一谈

现有 DSH 的 `vault/open` 票据本质是**设备间能力凭证**（peer/deposit/gen/archiveSha + 600s TTL + 签名），新增的子账号口令和门票是**用户侧入口凭证**，两者生命周期与撤销语义不同，建议分层建模。

| 层 | 凭证 | 生命周期 | 签发者 | 验证位置 | 本文对应 |
|---|---|---|---|---|---|
| L0 身份 | 主账号密钥/密码 | 长期，可轮换 | 主账号设备 | 主账号设备 | §1 能力凭证、§2 DPoP |
| L1 引导 | 子账号口令 / 邀请码 | 分钟~天，一次性或限次 | 主账号 | 主账号或门房设备（在线） | §3、§4 |
| L2 会话 | 终端绑定的受限会话令牌 | 小时级，可续期 | 门房/主账号 | 任意 DSH 节点离线 | §2 DPoP、§1 Biscuit/UCAN |
| L3 服务票 | mesh 入场、电台、游戏、缓存读取子票 | 分钟~小时，范围极窄 | 门房/服务方 | 目标服务/托管方 | §2 RAR/8693、§5 撤销 |

- 威胁假设：领票人**不是**可信运维；终端可能被调试、复制、转发；设备会断网数小时；网络层（LAN/Tailscale）只证明"能连通"，不证明"该授权"。
- 因此门票必须是**可离线验证、可在线撤销、带代次、带受众**的签名令牌，且短码只承担"首次兑换"，不承担日常鉴权。

## 1. 能力式委托：五个工业标准怎么选

| 机制 | 一句话原理 | 衰减（narrowing） | 离线验证 | 撤销 | 关键参数 | 适配我们？ |
|---|---|---|---|---|---|---|
| [Macaroons](https://www.ndss-symposium.org/ndss2014/ndss-2014-programme/macaroons-cookies-contextual-caveats-decentralized-authorization-cloud/) | 嵌套链式 HMAC + caveat 谓词；第三方 caveat 用 discharge macaroon 兑现 | 持票人追加 caveat（只能收窄） | 有根密钥即可本地验 | 无内建撤销；论文把撤销列为长期挑战，实践靠 caveat 时限/换根密钥 | caveat 谓词、root key、discharge | 实现极轻，适合"门票再收窄"；HMAC 版只有目标服务能验，且是 bearer |
| [Biscuit](https://www.biscuitsec.org/) | 公钥签名 + 追加式 block + Datalog check；任何知道公钥者可验 | 新 block 只能加 check，不能删旧块；可 sealed | ✅ 完全离线 | 每个 block 签名即 revocation id，可拒绝该 token 及其所有衰减后代 | Ed25519、block/check、revocation id、third-party block | **最贴近**：门票 + 逐级收窄 + 撤销 id 一次到位 |
| [UCAN](https://raw.githubusercontent.com/ucan-wg/spec/refs/heads/main/README.md) | DID 主体 + 委托链（delegation/invocation），无中心 AS | 委托只能收窄；有效期取链上最晚 nbf → 最早 exp | ✅ 本地优先设计 | 撤销是"前任委托者发出的不可伪造消息"，撤销库只增不减、可缓存/八卦传播 | `iss/aud/sub/exp/nbf/prf`、capability `{can,with}` | 思想最合 P2P；DID 基建对消费端偏重，可只借"链式证明 + 单调收窄" |
| [ZCAP-LD](https://w3c-ccg.github.io/zcap-spec/v0.4.0/) | JSON-LD 能力链，root → parentCapability → 子能力 | invocationTarget 只能加路径/查询后缀；expires 只能更短 | ✅ | 提交到验证方 revocation endpoint；验证方要保存已撤销项到过期 | `capabilityChain`、`parentCapability`、`invocationTarget` 前缀、`expires`、`allowedAction` | 撤销模型清楚；JSON-LD + DI proof 依赖重，不适合手机端轻量票 |
| [SPIFFE/SVID](https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/) | 工作负载身份：X509-SVID/JWT-SVID，短 TTL + 自动轮换 | 身份本身不衰减；靠受众/权限策略 | ✅（信任包本地验） | 不依赖逐证书 CRL，靠短寿命 + 轮换；[SPIRE 默认 X509 1h / JWT 5m](https://spiffe.io/docs/latest/deploying/spire_server/) | SPIFFE ID、`aud`、`exp`，JWT-SVID 强制 aud+exp（[规范](https://raw.githubusercontent.com/spiffe/spiffe/main/standards/JWT-SVID.md)） | 只适合 DSH 节点间 mTLS/工作负载身份；**不要发给不特定听众** |

**可抄具体项**

- **Macaroons**：`caveat = (predicate)` 链，验证时从 root key 逐条 HMAC 校验；第三方 caveat 内嵌"加密的根密钥 + 服务标识"，兑现方签发 discharge macaroon（论文 Fig.5/6）；适合"主账号发一张票，电台/游戏各自再加一条 caveat"的异构域，但无撤销、需防 root key 泄露。
- **Biscuit**：authority block 放 `right(...)`，后续 block 只能加 `check`；authorizer 生成 `revocation_id(index, signature)` 事实，与撤销名单比对即可拒绝该 token 及其后代；第三方 block 由可信第三方签名，适合"电台服务替主账号加播客范围校验"。
- **UCAN**：能力链每跳带 `iss/aud/exp/nbf/prf`；撤销是独立的 `ucan/revoke` 消息，各节点维护只增不减的撤销库，允许最终一致和缓存；规范明确"**主动过期优先于撤销**，因为过期不需要在线信息"（[UCAN Revocation](https://raw.githubusercontent.com/ucan-wg/revocation/main/README.md)）。
- **ZCAP-LD**：`capabilityChain` 必须包含 root 引用 + 完整父能力；衰减三件套 = 更短 `expires`、更窄 `invocationTarget` 前缀、更少 `allowedAction`；规范建议 `expires` 不超过三个月，因为验证方要存撤销项到过期。
- **SPIFFE/SVID**：JWT-SVID 必须带 `aud`（绑定具体服务）和 `exp`；短 TTL + 自动轮换替代 CRL 是业界共识，[Teleport 也明确"不支持传统证书撤销，只有 CA 轮换和 Locks"](https://goteleport.com/docs/zero-trust-access/management/security/revoking-access/)。

**选型结论**：门票格式优先 **Biscuit 思路（Ed25519 + 追加式 block + revocation id）**；若不想引入 Datalog 引擎，退化为"Ed25519 签名 JWT + 显式 scope 数组 + gen"也能覆盖 80% 需求。UCAN 只借链式证明与"过期优先"，ZCAP 只借 `parentCapability`/`invocationTarget` 前缀收窄，SPIFFE 只用于节点间身份。

## 2. OAuth 家族：陌生终端、短口令、降权与撤销

| 规范 | 解决什么 | 关键字段/参数 | 撤销/失效 | 可直接抄的点 |
|---|---|---|---|---|
| [RFC 8628 设备授权](https://www.rfc-editor.org/rfc/rfc8628.html) | 无浏览器/输入受限设备，用另一台设备完成授权 | `device_code`、`user_code`、`verification_uri(_complete)`、`expires_in`、`interval`（默认 5s）；错误 `authorization_pending`/`slow_down`(+5s)/`access_denied`/`expired_token` | 短 `expires_in`；设备码高熵；用户码限速 | 陌生人凭码接入的标准骨架 |
| [RFC 8693 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693.html) | 用主体令牌换更窄的下游令牌 | `subject_token(_type)`、`actor_token(_type)`、`requested_token_type`、`audience`、`resource`、`scope`、`expires_in`；`act` 嵌套链、`may_act` | 交换不自动传播撤销，需部署自行处理 | 子账号会话 → 电台/游戏/缓存子票；`act` 记录"谁代表谁" |
| [GNAP RFC 9635](https://www.rfc-editor.org/rfc/rfc9635.html) | 通用授权协商，可轮询/续谈/管理令牌 | grant request 的 `access[]`（`type/actions/locations/datatypes`）；`interact.user_code`（6~8 位、几分钟）；`continue{uri,wait,access_token}`；token 对象 `value/manage/access/expires_in/key/flags` | 管理 URI `POST` 轮换、`DELETE` 撤销（204）；grant 可整体撤销 | "每个令牌一个管理 URI"和 `durable` 标志 |
| [RFC 9449 DPoP](https://www.rfc-editor.org/rfc/rfc9449.html) | 发送方约束：令牌绑定终端公钥 | proof JWT：`typ=dpop+jwt`、`alg`、`jwk`、`jti`（≥96 bit/UUID）、`htm`、`htu`、`iat`、`ath`（令牌 SHA-256）、可选 `nonce`；响应 `token_type=DPoP`；令牌里 `cnf.jkt` | 支持 `DPoP-Nonce` + `use_dpop_nonce` 防预生成；私钥丢失即失效 | 防转发/防重放的核心 |
| [RFC 8705 mTLS](https://www.rfc-editor.org/rfc/rfc8705.html) | 证书绑定令牌 | 令牌 `cnf.x5t#S256`；mTLS 客户端证书 | 证书吊销（CRL/OCSP）+ 短 TTL | 若 DSH 节点已有设备证书，可复用 |
| [RFC 9396 RAR](https://www.rfc-editor.org/rfc/rfc9396.html) | 结构化授权范围 | `authorization_details[]`，必填 `type`，可选 `actions/locations/datatypes` | 随访问令牌撤销 | 把"限范围"写成可校验的结构 |
| [RFC 7009 撤销](https://www.rfc-editor.org/rfc/rfc7009.html) | 在线撤销 access/refresh token | `token`、`token_type_hint`；无效令牌也返回 200 | 立即失效（在线时） | 统一的 `/revoke` 端点 |
| [RFC 9700 安全 BCP](https://www.rfc-editor.org/rfc/rfc9700.html) | OAuth 安全基线 | 建议 access token **sender-constrained + audience-restricted**；public client 的 refresh token 必须绑定或轮换 | 刷新令牌轮换 + 重放检测→撤销整个 grant | 审计与入侵检测的基线 |

**2.1 陌生终端登录：把口令当"用户码"用，而不是当密码用**

- RFC 8628 把两类码分开：`device_code` 高熵、只给设备；`user_code` 给人读，8 位 base20（"BCDFGHJKLMNPQRSTVWXZ"）约 34.5 bit，配合限速与短有效期（GitHub 实例：`expires_in=900`、`interval=5`、8 位带连字符用户码，[文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow)）。**抄法**：终端显示短码/二维码 → 用户在自己手机输入口令完成"授权声明" → 终端轮询拿到绑定会话。
- 反转点：我们的口令是**发给不特定人的邀请凭证**，不是"用户批准自己设备"的 user_code。因此建议两阶段：口令只兑换一次（绑定首台设备），后续走 DPoP 会话；口令本身短 TTL、限次、可整批撤销，语义更接近 Tailscale auth key（one-off/reusable、1~90 天过期、ephemeral、pre-approved，[文档](https://tailscale.com/docs/features/access-control/auth-keys)）。
- 防钓鱼：RFC 8628 §5.4 建议用户交互时显示设备信息并确认设备在本人手上；设备码/用户码生命周期要"够用但短"以限制被转发钓鱼的价值。Storm-2372 正是滥用设备码流程：2024-08 起，攻击者用 WhatsApp/Signal/Teams 冒充熟人发"会议邀请"，诱导目标在真实微软页面输入 user_code，随后用截获令牌访问邮箱（攻击者拿到的是已完成 MFA 的令牌，等于绕过 MFA）；微软建议**能禁则禁设备码流、必须用时纳入条件访问、避免电话类 MFA**（[Microsoft Security Blog](https://www.microsoft.com/en-us/security/blog/2025/02/13/storm-2372-conducts-device-code-phishing-campaign/)）。

**2.2 降权与主体链：RFC 8693 的 `act` 怎么用**

- 子账号登录后不要拿"全权主账号 token"；用 token exchange 换 `audience=radio`/`audience=game`、`scope`/`authorization_details` 更窄的子票，并设置 `expires_in`。
- 委派用 **delegation 语义**：`sub` 仍是子账号，`act` 里放主账号（或门房设备），审计能回答"以谁的身份、代表谁、经几跳"。`act` 可嵌套成链（当前 actor 在最外层），消费方只把最外层 actor 作为访问控制依据，内层仅作历史记录。
- `may_act` 用于预先声明"谁有权代表我"（例如主账号声明某台手机可作为门房代发门票），可替代"手机号相同就提权"的危险启发式。

**2.3 DPoP：把"防转发"变成协议级保证**

- 终端生成密钥对，首次用口令兑换时在 token 请求带 DPoP proof；AS 返回 `token_type=DPoP` 且令牌内含 `cnf.jkt`。之后每次调用都带新 proof：`jti` 唯一（服务端做重放缓存）、`htm/htu` 绑方法/URL、`ath` 绑当前 access token。
- 服务端校验：`typ/alg/jwk`、签名、`htm/htu`、`iat` 窗口、`nonce`（如启用）、`ath` 与令牌哈希一致、`cnf.jkt` 与 proof 公钥一致。**门票服务、保险柜 RPC、电台 URL 都可套这一层**，转发者无终端私钥，拿到令牌也开不了柜。
- 若终端是 DSH 桌面实例，密钥放 OS keychain；手机端放 Secure Enclave/Keystore（B 文档详述）。

**2.4 范围结构化：RAR 风格的 `authorization_details`**

```json
{"authorization_details":[
 {"type":"mesh.join","actions":["join"],"locations":["tailnet:radio-listeners"]},
 {"type":"radio.listen","actions":["listen"],"locations":["radio:channel-7"]},
 {"type":"game.play","actions":["play"],"locations":["game:demo-42"]},
 {"type":"vault.cache.read","actions":["read"],"locations":["deposit:<hash>"]}
]}
```

- 校验规则：服务端逐项检查请求 ⊆ 票据范围；`locations` 用前缀/精确匹配；禁止用扁平 `scope="radio game vault"` 这种无法审计的字符串。
- GNAP 的 `access[]` 与 RAR 结构相近（`type/actions/locations/datatypes`），若未来要"续谈/扩范围"，GNAP 的 `continue` 机制比 RAR 更完整。

**2.5 撤销与安全基线**

- 在线时用 RFC 7009 统一撤销端点：`token` + `token_type_hint`，立即失效；对无效令牌也回 200，避免探测。
- [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) §4.10：AS "SHOULD 确保 access token 同时 sender-constrained 且 audience-restricted"；§4.14：public client 的 refresh token 必须发送方约束或轮换，检测到重放就撤销活跃令牌。门票服务应照此实现"一票一设备、刷新即换票、重放即全撤"。

## 3. 短口令/邀请码：熵、限速、绑定、并发

| 口令格式 | 组合数 | 熵（bit） | 评价 |
|---|---|---|---|
| 6 位数字 | 10^6 | ≈19.9 | 只能当一次性 OTP，绝不能当长期口令 |
| 6 位 base20（去元音） | 20^6 | ≈25.9 | 低于 RFC 8628 举例的 8 位；必须强限速 |
| 8 位 base20 | 20^8 | ≈34.5 | RFC 8628 §5.1 的示例值：配 5 次尝试可达 2^-32 猜测概率 |
| 10 位 base20 | 20^10 | ≈43.2 | 批量发不特定人群建议的下限 |
| 8 位 Crockford base32 | 32^8 | 40 | 可读性略差、抗爆破更好 |

| 控制点 | 工业做法/数值 | 来源 |
|---|---|---|
| 失败限速 | NIST：同一认证器/账号**连续失败 ≤100 次**即禁用，允许更低；可在接近上限时要求 30s~1h 递增等待 + bot 检测 | [NIST 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) |
| 锁定对象 | 计数器绑**账号/口令本身**，不绑源 IP（防换 IP 绕过）；建议 5~10 次/码/小时 | [OWASP 认证速查表](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) |
| 存储 | 口令不落明文：Argon2id，`t=3, p=4, m=64 MiB, salt=128 bit, tag=256 bit`（RFC 9106 第二推荐参数） | [RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html) |
| 防转发 | 首次兑换绑定终端公钥（DPoP `cnf.jkt`）；同码第二设备默认拒绝；并发设备上限（测试玩家 1、听众 2~3） | [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html) |
| 防截图 | 现场票用轮换码：TOTP 30s 步长或服务端 15s 轮换 QR；**一次性核销、拒绝重放** | [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238.html)、[NIST 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html)、[Ticketmaster SafeTix](https://www.mlb.com/padres/tickets/safetix) |
| 一次性 vs 多次 | 邀请码默认一次性（Vault response-wrapping 单次 token 思路）；复用码必须带 `max_uses` 与设备绑定 | [Vault response wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping) |

- **短码必须与设备密钥组合**：26~43 bit 的口令单独扛不住离线爆破（数据库泄露后 Argon2 也救不了 6 位口令），正确姿势是"口令只用于首次兑换，兑换后主体是终端私钥"。
- **子账号能力只含 login/session**：票据的 capability 集合里不出现 `account.update`/`password.change`/`mesh.admin`；不能靠 UI 隐藏，服务端必须按 capability 逐项拒绝。
- **拒绝"同码并发"**：同一口令在 2 个不同网络/设备同时在线即告警并可自动吊销；Tailscale 的 ephemeral key（设备离线即移除）和 auth key 过期（1~90 天）值得直接抄。
- **不要做账号枚举**：错误信息统一，口令校验用常数时间比较；对 404 与 403 的响应时间做统一。

## 4. 批量发码/门票运维：签发、轮换、吊销、审计

| 手段 | 原理 | 关键参数 | 撤销 | 适用 |
|---|---|---|---|---|
| 签名 URL/预签名票据 | 对资源 + 过期时间签名，持有 URL 即可取 | AWS S3 预签名 IAM 凭证最长 **7 天**，STS 会话默认 **1h**；任何拿到 URL 的人都能用 | 换密钥/短 TTL；无法单条撤销 | 一次性下载缓存包/回放包 |
| 轮换二维码 | 码=时间片 HMAC，终端定期刷新 | TOTP 默认 **30s** 步长、允许 1 步延迟；现场票可 15s 刷新 | 短窗口 + 一次性核销 | 现场入场、电台同步收听 |
| 批量签发 | 批次根密钥/批次号 + 逐票 ID | 批次 `batch_id`、`gen`、单票 `jti`、`max_uses` | 吊销整批 = 提升批次 gen 或整批拉黑 | 测试玩家/听众批次 |
| 撤销名单 | 位图/CRL 式列表，验证方缓存 | CRL 粒度受发布周期限制（时/日/周）；TSL：`bits∈{1,2,4,8}`、`lst`（zlib）、`ttl` 秒、状态 `0x00/0x01/0x02` | 在线拉取 + 本地缓存 | 离线设备 |
| 审计/看板 | 结构化事件 + 实时计数 | 签发/兑换/续期/撤销/失败五类事件，按 `jti` 幂等 | 审计驱动吊销 | 运营与事故响应 |

**4.1 轮换二维码（现场/电台）**

- 门票密钥 `K_ticket` 不出终端；二维码内容 = `ticket_id || counter || HMAC(K_ticket, ticket_id||counter||window)`；核销端校验当前/前一窗口并记录已用 `(ticket_id, window)` 防重放。
- 轮换周期取 TOTP 30s 或 15s；截图最多在窗口内有效，且因一次性核销无法二次入场；与 RFC 6238"至多允许 1 个时间步延迟"一致。

**4.2 撤销名单与代次**

- 小规模：主账号维护 `revoked_jti` 集合，签名后作为 `status_list` 分发；验证方缓存并带 `ttl`（Token Status List 草案允许用 `ttl` 声明可缓存秒数，[草案](https://drafts.oauth.net/draft-ietf-oauth-status-list/draft-ietf-oauth-status-list.html)）。
- 大规模：用版本/代次代替逐条枚举：每次"撤销任意票"就把 `auth_gen += 1`，旧代票全部失效；这比 CRL 更省带宽。代价是"撤销一张票"会吊销同代所有票，可再用"小代次 + 单个 `jti` 黑名单"两级兜底。
- CRL 的教训：撤销及时性受发布周期限制，[RFC 5280](https://www.rfc-editor.org/rfc/rfc5280.html) 直言"撤销粒度受 CRL 发布周期限制，可能长达 1 小时/1 天/1 周"——不要指望离线设备立刻知道。

**4.3 审计与会话看板（可直接照抄的字段）**

- 事件：`ticket.issued / redeemed / renewed / revoked / failed`，字段含 `jti`、`batch_id`、`sub`、`act` 链、`gen`、`device_jkt`、网络指纹（ASN/Tailscale node ID）、`iat`、结果与原因码。
- 看板：每张票当前活跃设备数、每子账号在线会话数、近 1h 失败率 topN、同票跨 ASN 告警、撤销操作人。
- 幂等：`jti` 用于防重放（DPoP 规范要求 `jti` 唯一并建议服务端做重放检测），同样的 `jti` 只允许一次兑换。

**4.4 真实案例（失败/教训）**

| 案例 | 发生了什么 | 教训 |
|---|---|---|
| [Storm-2372 设备码钓鱼](https://www.microsoft.com/en-us/security/blog/2025/02/13/storm-2372-conducts-device-code-phishing-campaign/) | 2024-08 起冒充熟人发会议邀请，诱导在真实页面输入 `user_code`，攻击者截获的是已完成 MFA 的令牌（等于绕过 MFA），随后访问 M365 | 设备码/短码必须显示设备信息、限制 TTL、绑定发起终端；能禁则禁 |
| [Clubhouse 邀请码转卖](https://www.yicai.com/news/100939382.html) | 每人限发 2 个邀请码，闲鱼炒到约 400 元、eBay 约 97 美元 | 不记名邀请码必然被转卖；需实名/设备绑定/批次限额/可追踪 |
| [Netflix 共享账号治理](https://www.npr.org/2023/05/24/1177848004/netflix-password-sharing) | 2023 年起限制"同住家庭"，非同住需 $7.99/月加成员；靠设备/网络信号判定同户 | 没有设备维度就只能靠"同户"启发式，误伤与绕过并存；门票应显式绑定设备而非猜 |
| [Ticketmaster SafeTix](https://www.mlb.com/padres/tickets/safetix) | SafeTix 用每 15 秒轮换的动态码，截图/打印件不能入场（静态码天然可复制） | 长期不变的码=可复制门票；轮换 + 一次性核销是现场票底线 |

## 5. 与"本地优先、离线可用、P2P 无中心"的冲突点

核心矛盾：**撤销是全局即时状态，离线设备只能看到本地缓存的旧状态**。工业界没有"零延迟撤销"魔法，只有四种折中：

| 折中 | 做法 | 撤销延迟上界 | 代价 |
|---|---|---|---|
| 短 TTL | [SPIFFE X509 1h / JWT 5m](https://spiffe.io/docs/latest/deploying/spire_server/)；[Tailscale auth key 1~90 天 + node key 180 天](https://tailscale.com/docs/features/access-control/key-expiry)；Teleport 短寿命证书 | ≤ TTL（=最坏情况要等票过期） | 续签流量、时钟/在线依赖 |
| 心跳/续期 | Vault lease 到期前 renew，否则 revoke；GNAP rotate；OAuth refresh | ≤ 下一个续期点 | 需要在线通道；离线时无法阻止 |
| 本地撤销名单缓存 | CRL（发布周期）、Token Status List（`ttl` 缓存）、UCAN 撤销库（只增、可 gossip） | ≤ ttl + 心跳间隔 | 缓存过期后必须 fail-closed 或降级 |
| 代次/快照 | Zanzibar `zookie` 保证读不早于某写入；DSH `vault` 的 gen；每次撤销 `auth_gen+1` | 取决于快照传播 | 粗粒度、可能误伤同代 |

- **推送型撤销**：[OpenID CAEP 1.0](https://openid.net/specs/openid-caep-specification-1_0.html) 定义 `session-revoked`/`credential-change`/`assurance-level-change`/`device-compliance-change` 等共享信号事件，在线设备可接近实时失效；离线设备仍要回到 TTL + 缓存名单兜底——**CAEP 是加速器，不是离线方案**。
- **离线验收准则（建议写进协议）**：任何"撤销后立即失效"的承诺都要标注上界 `delay ≤ min(TTL, statusListTTL + heartbeat)`；对开柜等敏感操作，撤销名单过期即拒绝（fail-closed）；对电台收听等低风险操作可 fail-open 但降码率/降权限并记录。
- **推荐算法（伪代码）**：

```text
verify(ticket, request, local_state):
  assert sig(ticket) and now in [nbf-skew, exp]
  assert ticket.aud == service and request.scope ⊆ ticket.scope
  assert ticket.gen >= local_state.min_gen
  assert proof.jkt == ticket.cnf.jkt and proof.htu/htm/ath match
  assert ticket.jti not in local_state.revoked_jti
  if local_state.status_age > local_state.status_ttl or local_state.gen_stale:
      if service.sensitivity == HIGH: reject("stale-status")   # fail-closed
      else: allow with degraded scope, log "stale-status"
  if same ticket seen on another device/ASN concurrently: revoke + alert
```

- 与 DSH 现状的映射：`vault/open` 已有 `peer/deposit/gen/archiveSha/kind/variant` 校验与 600s `keyTtl`，建议再加 `auth_gen`（撤销代次）、`jti`（防重放）、`device_jkt`（终端绑定）三项；子账号门票复用同一套签名/撤销管线，避免两套安全模型。
- 现设计稿里"手机号一致即把子账号当主账号"的提权应删除或改为：主账号设备对子账号提权请求**显式确认**（QR/通知确认码），并把 `act` 链写入审计；否则子账号口令泄露 + SIM swap 可直接拿到主账号能力。
- 另一处冲突："第一次连接默认受信"与零信任相悖。建议默认拒绝，未知 peer 必须凭门票/主账号确认进入；已受信 peer 也要按 `gen` 定期重新验证。

## 6. 对我们设计的 8 条硬性建议

1. **门票=签名能力令牌**：`Ed25519` 或 Biscuit，字段固定 `iss/sub/aud/scope[]/exp/nbf/gen/jti/device_jkt/limits`；任何 DSH 节点离线可验，衰减只能加 block/caveat。
2. **口令只做首次兑换**：兑换即绑定终端公钥（DPoP `cnf.jkt`），之后每次请求验 `jti/htm/htu/ath`；同码第二设备默认拒绝并告警。
3. **口令规格**：≥8 位 base20（≈34.5 bit），批量发不特定人群用 10 位 base20（≈43 bit）；纯数字至少 10 位且更严限速；Argon2id `t=3,m=64MiB,p=4` 存储；失败 5~10 次/码/小时即锁，遵循 NIST ≤100 次上限且优先更低。
4. **TTL 分层**：设备/用户码 10~15 min；入场兑换票 30~60 min；会话 1~12 h；开柜票 5~10 min（现有 600s 合理）；所有票带 `gen`，撤销即 `gen+1` 或 status list 置位。
5. **撤销三防线**：在线 `POST /revoke`（RFC 7009 思路）即时生效；离线用签名 Token Status List + `ttl` 缓存；敏感操作在名单过期时 fail-closed，低风险操作降级 fail-open 并留痕。
6. **范围结构化**：用 RAR/GNAP 风格 `authorization_details[]` 描述"mesh 入场/电台/游戏/缓存读取"，服务端逐项检查 ⊆；禁止扁平 scope 字符串。
7. **并发与审计**：每票 `maxDevices`（测试 1、听众 2~3），同票跨 ASN 告警；日志含 `jti/batch/gen/act/device_jkt`，底栏提供活跃会话看板与一键踢出。
8. **禁止身份启发式提权**：不把手机号/内网/IP 相同当信任依据；子账号提权必须主账号显式确认并记录 `act` 链；默认零信任，首次连接不自动受信。

## 参考来源（全部为实际抓取核验的公开链接）

- RFC 原文：[RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html) ｜ [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html) ｜ [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html) ｜ [RFC 9635 GNAP](https://www.rfc-editor.org/rfc/rfc9635.html) ｜ [RFC 9396 RAR](https://www.rfc-editor.org/rfc/rfc9396.html) ｜ [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009.html) ｜ [RFC 8705](https://www.rfc-editor.org/rfc/rfc8705.html) ｜ [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html) ｜ [RFC 6238 TOTP](https://www.rfc-editor.org/rfc/rfc6238.html) ｜ [RFC 9106 Argon2](https://www.rfc-editor.org/rfc/rfc9106.html) ｜ [RFC 5280 CRL](https://www.rfc-editor.org/rfc/rfc5280.html)
- 能力式委托：[Macaroons 论文（NDSS 2014）](https://www.ndss-symposium.org/ndss2014/ndss-2014-programme/macaroons-cookies-contextual-caveats-decentralized-authorization-cloud/) ｜ [Macaroons PDF](https://www.ndss-symposium.org/wp-content/uploads/2017/09/04_3_1.pdf) ｜ [libmacaroons](https://github.com/rescrv/libmacaroons) ｜ [Biscuit](https://www.biscuitsec.org/) ｜ [Biscuit 规范](https://raw.githubusercontent.com/eclipse-biscuit/biscuit/main/SPECIFICATIONS.md) ｜ [UCAN 规范](https://raw.githubusercontent.com/ucan-wg/spec/refs/heads/main/README.md) ｜ [UCAN Revocation](https://raw.githubusercontent.com/ucan-wg/revocation/main/README.md) ｜ [ZCAP-LD v0.4.0](https://w3c-ccg.github.io/zcap-spec/v0.4.0/) ｜ [SPIFFE 概念](https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/) ｜ [SPIRE 配置默认 TTL](https://spiffe.io/docs/latest/deploying/spire_server/) ｜ [JWT-SVID 规范](https://raw.githubusercontent.com/spiffe/spiffe/main/standards/JWT-SVID.md)
- OAuth 工程实践：[GitHub 设备流文档](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow) ｜ [Microsoft Storm-2372](https://www.microsoft.com/en-us/security/blog/2025/02/13/storm-2372-conducts-device-code-phishing-campaign/) ｜ [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) ｜ [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) ｜ [Token Status List 草案](https://drafts.oauth.net/draft-ietf-oauth-status-list/draft-ietf-oauth-status-list.html) ｜ [OpenID CAEP 1.0](https://openid.net/specs/openid-caep-specification-1_0.html) ｜ [Zanzibar FAQ（zookie）](https://pdos.csail.mit.edu/6.824/papers/zanzibar-faq.txt)
- 厂商/运维：[Tailscale auth keys](https://tailscale.com/docs/features/access-control/auth-keys) ｜ [Tailscale key expiry](https://tailscale.com/docs/features/access-control/key-expiry) ｜ [AWS 预签名 URL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) ｜ [Vault response wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping) ｜ [Vault lease/renew/revoke](https://developer.hashicorp.com/vault/docs/concepts/lease) ｜ [Teleport 撤销访问](https://goteleport.com/docs/zero-trust-access/management/security/revoking-access/)
- 事件/案例：[Ticketmaster SafeTix（15s 轮换码）](https://www.mlb.com/padres/tickets/safetix) ｜ [Netflix 共享账号治理（NPR）](https://www.npr.org/2023/05/24/1177848004/netflix-password-sharing) ｜ [Clubhouse 邀请码转卖（第一财经）](https://www.yicai.com/news/100939382.html)
