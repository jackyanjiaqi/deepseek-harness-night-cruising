# B · 手机钥匙与设备绑定 — 调研笔记（DSH account-mesh 手机端设计输入）
> 调研日期 2026-11-28。场景：手机 = 独立终端（通知/授权中心、消费终端、远程 Agent 终端）+ 保险柜钥匙；桌面只在手机签名后放行。本文只写可执行参数与来源，不写厂商营销话术。
## 结论摘要
- **最值得抄 ①：设备私钥签名式确认**——高危操作不是"手机回一个 approve"，而是手机用**不可导出的设备私钥**对「规范化操作摘要 + 一次性挑战」签名，桌面验签后才执行；这直接复用 WebAuthn/CTAP 的挑战-签名-UV 模型（[W3C WebAuthn L3](https://www.w3.org/TR/webauthn-3/)、[CTAP 2.2](https://fidoalliance.org/specs/fido-v2.2-ps-20250714/fido-client-to-authenticator-protocol-v2.2-ps-20250714.html)）。
- **最值得抄 ②：扫码配对 + 邻近性证明 + 设备清单/一键注销**——CTAP 2.2 hybrid（caBLE）把"临时公钥 + 一次性 secret + 时间 + 流程提示"放进 QR，用 BLE 20 字节广播做**物理邻近证明**，并用状态辅助重连与 `410 unlinked` 表达注销语义（[CTAP §11.5](https://fidoalliance.org/specs/fido-v2.2-ps-20250714/fido-client-to-authenticator-protocol-v2.2-ps-20250714.html#sctn-hybrid)）。
- **最值得抄 ③：passkey PRF 派生 KEK 包裹保险柜 DEK**——PRF 输出 32 字节，可作 KEK 包裹 DEK，从而"手机当钥匙但可随 passkey 同步恢复"；WebAuthn 明确以"用 PRF 输出做对称密钥加密用户数据"为设计动机（[W3C §10.1.4 prf](https://www.w3.org/TR/webauthn-3/#prf-extension)），Bitwarden 已实现"PRF-capable passkey 解密保险库"（[Bitwarden 白皮书](https://bitwarden.com/help/bitwarden-security-white-paper/)）。
- **最该避开 ①：手机号/SMS 当身份或恢复凭证**——NIST SP 800-63B-4 把 PSTN 带外认证列为**唯一 restricted authenticator**，要求先用"换机/换 SIM/携号转网"等风险指标（[NIST](https://pages.nist.gov/800-63-4/sp800-63b.html)）；2021 年 FBI IC3 收到 1,611 起 SIM swap 投诉、损失超 6,800 万美元（[FBI PSA](https://www.ic3.gov/PSA/2022/PSA220208)）。
- **最该避开 ②：synced passkey 当唯一钥匙、且无 attestation/无设备清单**——FIDO 明确指出 synced passkey 私钥会进入厂商同步云、当前不支持 attestation、且 RP 无法知道密钥被同步到哪些设备，属"较低安全姿态"（[FIDO 白皮书](https://fidoalliance.org/white-paper-fido-authentication-for-moderate-assurance-use-cases/)）。

## 1. 先拆三个词：身份 / 设备 / 持有证明
我们所有规则（含"子账号按主账号受信"）都必须落在这三个正交维度上，否则必然把"同手机号"混进身份判断。

| 概念 | 定义 | 载体与验证方式 | 在本项目中的落点 |
|---|---|---|---|
| **身份 Identity（谁）** | 账号网域中的稳定主体，`user.id` 不变 | 账号服务签发的 user id + 角色（主/子账号）；WebAuthn 要求 `user.id` 稳定且不随用户名变化 | `accountId`；子账号有独立 user.id，但**角色信任策略**继承主账号 |
| **设备 Device（哪台机器）** | 一台具体终端 + 其设备密钥对 | 设备公钥指纹 + 平台 attestation + 节点 key（Tailscale 里是 node key） | `deviceId` + `phonePub` / `desktopPub` + attestation 记录 |
| **持有证明 Holder proof（此刻是不是同一人）** | 每次操作时的本地签名 + 用户验证（UV） | 生物识别/PIN 解锁的私钥签名 + 新鲜度（authAge） | 每次高危确认都签**新**挑战，不缓存、不复用 |
| （辅助信号）手机号 | 联络方式、弱风控信号 | **无法验证"同人"**，只可作异常提示 | 不进入认证因子，不进入恢复因子 |

要点：WebAuthn 天然区分"身份/凭证/认证器"——同一 `user.id` 可以注册多张凭证，并且 RP **应该** 用 `excludeCredentials` 确保新凭证绑定到不同认证器；规范同时明确"认证器丢失=凭证丢失"（[§13.5.6 Credential Loss and Key Mobility](https://www.w3.org/TR/webauthn-3/#sctn-credential-loss-key-mobility)）。这正是"手机号相同 ≠ 同一持有者"的规范级依据：可验证的是密钥，不是号码。

## 2. WebAuthn / Passkeys：能证明什么，不能证明什么
### 2.1 四类凭证的定位差异
| 类型 | 私钥在哪 | 能否导出/同步 | 丢机/换机恢复 | 适配我们的取舍 |
|---|---|---|---|---|
| **device-bound platform passkey** | 本机安全芯片（SE/StrongBox/TEE），`BE=0` | 不可导出、不同步 | 只能靠注册第二把凭证 | ✅ 手机钥匙的**基线**；满足"手机比桌面难破解"的假设 |
| **synced passkey** | 厂商同步云（E2E 加密），`BE=1` | 可同步到同生态设备 | 用厂商账号恢复流程 | ⚠️ 只作**恢复/兜底**，不作唯一钥匙（无 attestation、无法枚举设备） |
| **FIDO2 硬件密钥（resident key）** | 安全元件内 | 不可导出 | 需备用钥匙 | ✅ 桌面端"高保证"第二因子；可做恢复钥匙 |
| **PIV 证书槽（如 YubiKey 9c/9d）** | 芯片内，PIN 保护 | 不可导出 | 需备用钥匙 | ✅ 企业场景；`9c=数字签名`、`9d=密钥管理`（[Yubico PIV](https://developers.yubico.com/PIV/Introduction/Certificate_slots.html)） |

`BE`/`BS` 两个标志位来自 authenticatorData flags：`BE` 表示"备份资格"（永久属性），`BS` 表示"当前是否已备份"，RP 必须据此区分"单设备凭证 vs 多设备凭证"（[§6.1 Authenticator Data](https://www.w3.org/TR/webauthn-3/#sctn-authenticator-data)）。**我们不能只看"有没有 passkey"，必须读 BE/BS 判断它是不是"只在手机芯片里"。**

### 2.2 PRF 扩展：用 passkey 派生包裹密钥（可抄步骤与参数）
1. **注册**：`navigator.credentials.create()` 时带 `extensions.prf.eval.first = SHA-256("dsh/vault-kek/v1" || vaultId)`；浏览器会把输入再加工为 `salt = SHA-256("WebAuthn PRF" || 0x00 || first)`，authenticator 返回 32 字节 PRF 输出（[W3C §10.1.4](https://www.w3.org/TR/webauthn-3/#prf-extension)）。
2. **注册时可能拿不到输出**：部分认证器不支持在 create 阶段求值，规范要求此时**再发一次 assertion** 才能拿到 PRF 结果——我们的注册流程必须包含这一步，不能假设 create 就返回。
3. **派生**：`KEK = HKDF-SHA256(prf_out, salt = vaultId16, info = "dsh-dek-wrap-v1")`，32 字节；`DEK_wrapped = AES-256-GCM(KEK, DEK, aad = vaultId || keyEpoch)`。托管方只存 blob。
4. **开柜**：对同一 credential 发 `get()`（要求 UV=true），取 PRF → 派生 KEK → 解包 DEK，内存用完即弃。
5. **轮换**：用 `eval.second` 或新随机 salt 在每次开柜后重新派生并重包 DEK（W3C 明确给出"每次 assertion 用新输入轮换加密密钥"的用法）。
6. **强约束**：PRF 与 passkey 同生共死——**删 passkey = 加密数据永久不可解**；必须在产品里写明，并提供 device-bound 兜底或恢复码。

PRF 现状必须按平台核对（下表为第三方汇总，用于排期判断，不作规范引用）：

| 平台 | PRF 状态 | 备注 |
|---|---|---|
| Android + Google Password Manager | ✅ 支持最完整 | 同步 passkey 默认支持 PRF，跨浏览器可用 |
| Chrome/Edge 桌面 | ✅（Chrome 116+ 取；Chrome 147 起 create 阶段） | 需平台认证器支持 hmac-secret |
| macOS 15+ / Safari 18+ | ✅ | 安全密钥 PRF 支持较晚 |
| **Windows Hello** | ❌ | **Windows Hello 缺 hmac-secret**，桌面平台认证器不能做 PRF |
| iOS/iPadOS 18.0–18.3 | ⚠️ 有 bug | 作为跨设备源时存在 PRF 值不一致/数据丢失报告，18.4+ 才较稳 |

来源：[corbado PRF 汇总（2026-08 实测）](https://www.corbado.com/blog/passkeys-prf-webauthn)。结论：**PRF 只放在手机侧**，桌面侧不依赖；且 PRF 是"可选项"而非唯一路径。

### 2.3 CTAP 2.2 hybrid / caBLE：扫码 + 邻近性的标准流程
1. 桌面显示 QR：内容是 `FIDO:/` + **十进制数字编码**的 CBOR map（规范给出逐字节编码算法）。
2. QR 只包含 6 个字段：`key0` 33 字节压缩 P-256 公钥（认证桌面）、`key1` 16 字节随机 `qrSecret`（认证手机）、`key2` 隧道域名数量、`key3` epoch 秒、`key4` 是否支持状态辅助、`key5` 流程提示（`ga`=getAssertion / `mc`=makeCredential / `dcp`/`dci`）。
3. 手机扫到后先给用户提示，再通过隧道服务建连；**连接尝试以 BLE 广播形式出现**，UUID `0000fff9-0000-1000-8000-00805f9b34fb`，携带 20 字节 service data，用 QR secret 派生的密钥 trial decrypt 匹配——**没有物理邻近就无法完成**，从而防止"恶意网站远程展示 QR 骗人扫"。
4. 密钥派生：HKDF-SHA256，`info` 为 32 位小端"用途标识"，父子密钥做域分离。
5. **状态辅助重连**：此前配对过则不用再扫码，客户端用缓存的 link ID 连 `wss://<tunnel>/cable/contact/<contactId>`；隧道返回 **HTTP 410 表示 `device unlinked`**（[CTAP §11.5.2](https://fidoalliance.org/specs/fido-v2.2-ps-20250714/fido-client-to-authenticator-protocol-v2.2-ps-20250714.html#hybrid-state-assisted)）。
6. 因为两端**没有天然互信通道**，IETF 明确把这类 QR/PIN 流程列为"通过未认证信道传递、无设备间双向认证"，并把**邻近性**列为首选缓解（[IETF Cross-Device Flows BCP](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-cross-device-security)）。

**对我们的直接映射**：QR 里放临时公钥 + 一次性 secret + TTL + 流程提示；无 BLE 时用"双端 6 位校验码 + 局域网 mDNS/短 TTL"替代邻近性；配对**永不**在二维码里放长期密钥或账号明文。

### 2.4 密钥只存在本机安全芯片：SE / StrongBox / TEE
| 机制 | 密钥生成/存放 | 不可导出语义（可写进验收） | 使用约束 | 我们怎么用 |
|---|---|---|---|---|
| **iOS Secure Enclave** | P-256 密钥在 SEP 内生成；根密钥 `UID` 每机唯一、熔丝固化，**不可经 JTAG/调试口读取** | AES 硬件密钥"即使在 sepOS 内也不可见"，软件只能请求运算不能取密钥；文件密钥以 UID 绑定，SSD 换机即不可解 | Secure Enclave 无存储，需与安全非易失存储配合；密码尝试超限（iPhone 为 10 次）即**抹除受密码保护数据** | 手机设备私钥生成于此；每次签名要求生物识别 |
| **Android Keystore + StrongBox** | StrongBox KeyMint 在独立安全元件中；密钥可 `setUserAuthenticationRequired(true)` 绑定生物识别，`setInvalidatedByBiometricEnrollment(true)` 在录入新指纹后作废 | 密钥材料不可导出，只能请求签名；支持**密钥 attestation**（可校验"确实在 StrongBox 内"） | StrongBox 支持的算法/长度是子集，并发能力有限；普通场景官方建议普通 Keystore 即可 | 生成手机确认密钥；用 attestation 证书链做设备证明；录入新生物特征即作废旧密钥（防"知道锁屏密码的人加指纹"） |
| **TEE-only（无独立 SE）** | 主处理器安全世界 | 防软件层，不防硬件物理攻击 | 成本低、覆盖广 | 降级信任标记：`deviceAssurance=tee`，高危操作要求第二因子 |
| **WebAuthn 认证器（device-bound）** | authenticator 内 | `BE=0` 可被 RP 验证 | 需 UV/UP | 作为跨端统一封装，底层仍是上面几种 |

来源：[Apple 平台安全指南 · 安全隔区](https://support.apple.com/guide/security/secure-enclave-sec59b0b31ff/web)、[Android Keystore](https://developer.android.com/privacy-and-security/keystore)、[AOSP Keystore/KeyMint](https://source.android.com/docs/security/features/keystore)；attestation 格式见 WebAuthn [§8.4 Android Key Attestation](https://www.w3.org/TR/webauthn-3/#sctn-android-key-attestation) 与 [§8.8 Apple Anonymous Attestation](https://www.w3.org/TR/webauthn-3/#sctn-apple-anonymous-attestation)。

## 3. 手机作为密钥持有者：产品先例
| 产品 | 主密钥如何包裹/分层 | 恢复码设计 | 丢手机/换机 | 我们可抄什么、取舍是什么 |
|---|---|---|---|---|
| **1Password** | 账号密码（约 40 bit 熵）**+ Secret Key**（34 字符、128 bit 熵）合成完整加密密钥（2SKD）；Secret Key 从不上传 | Emergency Kit 纸质包存 Secret Key；不提供"客服帮你解密" | 新设备输入密码 + Secret Key，或从 iCloud/Android 备份恢复 | ✅ 抄"第二秘密 + 应急包"；❌ 它依赖"厂商拿不到密钥"但仍有账号服务器，我们无服务器场景需把 Secret Key 换成设备公钥包裹 |
| **Bitwarden** | 主密码 → KDF（默认 PBKDF2 600,000 轮，可改 Argon2id）→ 主密钥；**PRF-capable passkey 可直接解密保险库** | 2FA 恢复码；紧急访问（用对方 RSA 公钥包裹对称密钥 + 等待期） | 主密码 + 恢复码 / 紧急联系人 | ✅ PRF 包裹 DEK 的现成产品证据；✅ "Log in with device"（已登录设备批准登录）就是桌面→手机审批 |
| **Apple 密码 / passkeys** | iCloud 钥匙串 E2E 同步；受信任设备显示 6 位验证码 | 受信任设备 + 受信任电话号码双通道 | 新设备登录需旧设备验证码或受信任号码 | ✅ "已在受信任设备上显示验证码"体验；❌ 恢复仍可能落到手机号 |
| **YubiKey PIV / FIDO2** | 私钥在芯片内，PIV 需 PIN 才能私钥运算；FIDO2 resident key 同样不可导出 | 无软件恢复，靠**备用钥匙** | 换机需重新注册备用钥匙 | ✅ "硬件持有 + PIN"双因素；✅ 备用钥匙策略；❌ 单钥匙丢失即锁死 |

恢复码设计要点（综合以上）：≥128 bit 熵、Base32/Crockford 分组 + 校验和（如 [SLIP-39](https://github.com/satoshilabs/slips/blob/master/slip-0039.md) 的"组阈值/成员阈值 + 校验和"格式）、离线打印、**用后即轮换**、与设备密钥分离存放、恢复动作本身视为高危操作需二次确认。

## 4. 手机作为受信审批端：配对、设备清单、通知内容
### 4.1 配对与设备清单
| 产品 | 配对流程 | 设备清单/上限 | 闲置/过期 | 远程注销的效果 |
|---|---|---|---|---|
| **Apple 受信任设备 + 双重认证** | 新设备登录时，6 位验证码**自动显示在已受信任设备**上，或发到受信任电话号码 | 设备列表可查看/移除；移除后需重新验证 | 长期不用需重新验证 | 移除设备后该设备不再收到验证码 |
| **Google Prompt** | 已登录 Google 账号的 Android 手机上弹通知，"点一下"确认 | 只发给已登录设备 | — | 移除设备后不再收 prompt |
| **Microsoft Authenticator（无密码手机登录）** | 设备绑定密钥 + PIN/生物识别；登录时**号码匹配**：登录页显示数字，用户在 App 输入 | 每账号可注册多台 | — | 吊销后无法再批准 |
| **Signal linked devices** | 主手机**扫码**配对；每台关联设备使用独立密钥 | 官方帮助：单账号最多 5 台（主手机 + 至多 4 台关联设备），可查看并远程解绑；长期不活跃会自动解除关联 | 不活跃自动解绑 | 解绑即会话密钥作废，需重新扫码 |
| **WhatsApp companion** | 手机 + **至多 4 台**非手机设备；扫码关联 + **生物识别确认**；每台 companion **拥有自己的 identity key** | 设备列表可管理 | — | 解绑后该设备不再收到消息 |
| **Telegram** | **手机号登录**，可同时登录任意多设备（云端同步） | Settings → Devices / Active Sessions 可看会话并**一键终止** | — | 终止会话后旧设备无法再收消息（反面教材：号码=身份） |
| **Tailscale** | auth key 或交互登录；可开 **device approval**，新设备需人工批准 | 管理台设备列表 + tag 身份 | **node key 默认 180 天过期**；auth key 有效期 1–90 天（默认 90） | 删除设备/撤销 key 后即断连 |

来源：[Apple 双重认证](https://support.apple.com/en-us/102660)、[Google prompts](https://support.google.com/accounts/answer/7026266)、[MS 号码匹配](https://learn.microsoft.com/en-us/entra/identity/authentication/how-to-mfa-number-match) 与 [无密码手机登录](https://learn.microsoft.com/en-us/entra/identity/authentication/howto-authentication-passwordless-phone)、[Signal 关联设备](https://support.signal.org/hc/en-us/articles/360007320771)、[WhatsApp 多设备架构](https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/)、[Telegram FAQ](https://telegram.org/faq#q-how-do-i-use-my-account-on-multiple-devices)、[Tailscale auth key](https://tailscale.com/docs/features/access-control/auth-keys) 与 [key expiry](https://tailscale.com/docs/features/access-control/key-expiry)。

### 4.2 通知里必须有什么，才防得住钓鱼与"盲批准"
| 通知要素 | 防什么 | 现实参数 |
|---|---|---|
| **号码匹配**（登录端显示数字，手机端输入） | 防 MFA fatigue / 无脑点"批准"：攻击者无法代替你输入 | Microsoft 已对所有 Authenticator push **强制启用且用户不可关闭**；同设备场景改为同机比对 |
| **操作摘要 + 一次性数字/内容绑定** | 防"批准的不是我以为的操作"（签名必须覆盖摘要哈希，见 §8.3） | 摘要展示金额/对象/操作类型；签名覆盖 `opDigest` |
| **来源设备 + 位置 + 时间** | 防异地/陌生设备发起的授权请求 | Google prompts 会展示设备、位置、时间；Apple 双重认证也展示登录地点 |
| **生物识别且无 passcode 回退** | 防"知道锁屏密码的人"（被胁迫/偷看密码） | Apple 偷窃设备保护（SDP）对存密码等操作要求 Face ID/Touch ID，**没有密码回退** |
| **安全延迟** | 给受害者撤销窗口，阻断即时高危改动 | SDP 对改 Apple 账号密码等操作要求**等待 1 小时**后再生物识别（离家场景默认开启） |
| **速率限制 + 拒绝静默重试** | 防 fatigue 轰炸 | 同一操作短时间失败即锁定并要求重新发起 |

来源：[MS number matching](https://learn.microsoft.com/en-us/entra/identity/authentication/how-to-mfa-number-match)、[Google prompts](https://support.google.com/accounts/answer/7026266)、[Apple 偷窃设备保护](https://support.apple.com/en-us/120340)。

## 5. 手机号为何不能当凭证
| 攻击 | 已发生案例（可查） | 运营商/行业缓解 | 对我们结论 |
|---|---|---|---|
| **SIM swap（社工客服补卡）** | 2021 年 IC3 接 1,611 起投诉、损失 >6,800 万美元；2018–2020 共 320 起、约 1,200 万美元（[FBI PSA](https://www.ic3.gov/PSA/2022/PSA220208)） | 客服身份核验流程、变更通知、port-out PIN/号码锁（[FCC 消费者指南](https://www.fcc.gov/consumers/guides/sim-swapping-scam)）；FBI 建议个人改用生物识别/硬件令牌/独立认证 App | 号码被接管即可收验证码，**同号 ≠ 同人** |
| **SIM swap 直接盗取资产** | 投资人 Michael Terpin 因 AT&T 相关 SIM swap 被盗约 2,400 万美元，获 7,580 万美元判决（[判决通报](https://www.greenbergglusker.com/litigation/news/cryptocurrency-investor-michael-terpin-wins-75-8-million-judgment-in-first-ever-sim-swap-racketeering-case)） | 同上 | 手机号作为恢复因子 = 把保险柜钥匙交给运营商客服 |
| **平台级入侵** | NYDFS 调查认定 2020-07-15 Twitter 入侵始于 SIM swap（[NYDFS 报告](https://www.dfs.ny.gov/Twitter_Report)） | 内部权限与认证加固 | 即使平台本身很"重"，手机号仍是单点 |
| **SS7 / 运营商信令网** | NSA/GCHQ 入侵 SIM 卡厂商 Gemalto，窃取用于保护全球手机通信的密钥（[The Intercept 报道](https://theintercept.com/2015/02/19/great-sim-heist/)） | 网络侧升级（昂贵、非我们能控） | 号码与短信通道**在架构上就不可信** |
| **规范层结论** | NIST 把 PSTN 带外认证列为**唯一 restricted authenticator**，要求 verifier 在发码前考虑"设备更换、SIM 更换、携号转网"等风险指标，且必须提供不受限的替代认证器（[NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)） | — | 手机号最多是**风控信号**，不能进入认证/恢复路径 |

**替代方案（我们要写进设计的）**：设备绑定密钥（不可导出）+ 手机持有私钥的**每次签名**（覆盖挑战与操作摘要）+ 可选平台 attestation；手机号只做"异常提示与联系渠道"，并在 UI 里明确"更换手机号不影响钥匙"。

## 6. 门限与恢复：离线 / 无服务器场景的取舍
| 方案 | 原理 | 离线可用 | 丢失风险 | 适用 |
|---|---|---|---|---|
| **Shamir k-of-n（SLIP-39 风格）** | 把主密钥拆成 n 份，任意 k 份可重构；支持组阈值/成员阈值 + 校验和 + passphrase | ✅ | 少于 k 份=永久丢失；份额泄露即可被重构 | 离线恢复码、跨设备备份 |
| **2-of-2（手机 + 桌面）** | DEK 由两端份额派生（ECDH/HKDF），或 2-of-2 门限签名（[FROST RFC 9591](https://www.rfc-editor.org/rfc/rfc9591.html)） | ✅（P2P 同时在线） | 任一端丢失即无法开柜 → **必须有第三 shard** | 高危开柜/提升受信等级 |
| **恢复码** | 128 bit+ 随机码直接包裹 DEK 或作为第二 shard | ✅ | 纸张丢失/被拍照 | 所有人必须有的最后兜底 |
| **社交恢复（guardians）** | 多数 guardian 可更换签名密钥，无需转移资产（[Vitalik 说明](https://vitalik.eth.limo/general/2021/01/11/recovery.html)） | ⚠️ 需多方在线 | 串谋风险；隐私差 | 可选，不建议默认开 |
| **可信硬件辅助恢复** | Signal 用 Argon2 拉伸 PIN → 32B 密钥 + 密钥拆分 + 安全区限制猜测量级（[Signal SVR](https://signal.org/blog/secure-value-recovery/)） | ❌ 需服务器 | 依赖厂商 enclave | 我们"无服务器"场景**不适用**，仅作对照 |

取舍结论：**2-of-2 提高门槛但会制造"双丢即死"**，必须配"离线恢复码或第三设备 shard"；恢复动作本身要高危确认 + 延迟窗口。

## 7. Tailscale 的分层信任模型（网络层 vs 应用层）
| 机制 | 关键事实/参数 | 可抄到应用层的点 |
|---|---|---|
| **auth key** | 可设 reusable（危险，官方明确提示慎用）、ephemeral（设备离线即删）、pre-approved（已开 device approval 时免人工批准）、**tags**（设备获得 tag 身份）；有效期 1–90 天，未指定默认 90 天（[文档](https://tailscale.com/docs/features/access-control/auth-keys)） | 配对凭据要区分"一次性/可重用/预批准/带角色标签"，并设**短有效期** |
| **key expiry** | node key **默认 180 天**过期；tagged 设备默认不过期；过期后需重新认证（[文档](https://tailscale.com/docs/features/access-control/key-expiry)） | 设备受信要**定期重新证明**；高危角色可缩短周期 |
| **device approval** | 可开启"新设备需人工批准才能入网"（[文档](https://tailscale.com/docs/features/access-control/device-management)） | 新设备首次入网 = 需要手机批准（与我们的"受信等级提升"同构） |
| **tags / ACL** | tag 是"非用户设备"的身份，设备身份 = 所有 tag 的组合；tagged 设备不能 SSH 到用户设备（[tags](https://tailscale.com/docs/features/access-control/tags)、[ACL](https://tailscale.com/docs/features/access-control/acls)） | 用 tag/role 表达"能力"，不要用"是不是同一个账号"表达权限 |
| **Tailnet Lock** | 每节点有 TLK（Tailnet Lock Key）；TKA 记录受信 TLK；新节点公钥必须由受信"签名节点"签名，peer 验证后才连接；采用 TOFU；禁用需要**初始化时生成的一次性 disablement secret**；即使 Tailscale 控制面被攻破也无法偷偷加入节点（[文档](https://tailscale.com/docs/features/tailnet-lock)） | **核心启示**：账号/协调服务器被攻破 ≠ 能进保险柜；应用层必须"本地签名 + 已知设备集合"双保险 |

我们的分层建议：Tailscale 只当"**可达性/网络层受信**"，绝不把 tailnet 成员资格当应用层权限；应用层另有一套设备密钥、审批签名与 `keyEpoch`，两者互不替代。

## 8. 手机作为保险柜钥匙：3 种架构与推荐顺序
### 8.1 三种可选架构
| 架构 | 密钥在哪 | 开柜流程 | 丢失/换机恢复 | 攻击面 | 评价 |
|---|---|---|---|---|---|
| **A. 纯设备密钥** | 手机 SE/StrongBox 内生成 P-256，不可导出；DEK 用手机公钥包裹（ECIES/HKDF+AES-GCM），或手机对开柜挑战签名 | 手机签名/解包 → 桌面验签/解密 → 短时票据开柜 | 手机丢了就开不了；靠恢复码或备用设备 | 手机被盗但锁屏/生物识别仍在；attestation 可校验 | ✅ 最强、最简单、离线可用的**基线** |
| **B. passkey + PRF 派生包裹密钥** | passkey 私钥（可同步）+ PRF 输出派生 KEK；DEK 被 KEK 包裹 | 手机做一次 assertion（UV）→ 派生 KEK → 解包 DEK（或只解包"操作密钥"） | 借 passkey 同步恢复（iCloud/Google） | synced passkey 姿态较低；PRF 平台支持不一致；删 passkey=数据丢失 | ⚠️ 恢复体验最好，**只作兜底/可选** |
| **C. 2-of-2 门限（手机 + 桌面）** | DEK = KDF(sharePhone, shareDesktop)，两份 share 各自在设备安全芯片 | 两端同时在线，ECDH/门限签名合成 → 开柜 | 单丢即锁死，必须第三 shard/恢复码 | 需要同时在线；实现复杂 | ✅ 高危操作（开柜/提权/大额）的第二道门 |

### 8.2 推荐顺序与理由
**推荐：A 作为默认基线 → C 叠加到高危操作 → B 作为可选恢复与只读场景。**

1. **A 先做**：它把"手机比桌面难破解"直接转化为密码学保证（私钥不可导出、attestation 可验证），且不依赖任何云；P2P（LAN/Tailscale）即可完成。
2. **C 后加**：只有把"桌面已被攻破"也纳入威胁模型时，2-of-2 才有意义；但它引入"双丢即死"，所以必须在 A 稳定、恢复码上线之后再加。
3. **B 最后**：synced passkey 的便利性建立在"私钥会进同步云"之上，与 FIDO 对 synced passkey"较低安全姿态、无 attestation、无法枚举设备"的定性冲突（[FIDO 白皮书](https://fidoalliance.org/white-paper-fido-authentication-for-moderate-assurance-use-cases/)），只适合"恢复/只读/低危"。
4. 若产品必须"无 App 也能用"，则 B 作为**过渡路径**，但要在 UI 明确标注"此模式安全等级低于设备密钥"，并在 UI 层用 `BE/BS` 标志区分。

### 8.3 可抄流程与参数（可交给实现）
**① 配对二维码内容（TTL ≤ 120s，一次性）**

| 字段 | 长度/类型 | 说明 |
|---|---|---|
| `v` / `type` | 1B / 字符串 | 协议版本；`dsh-pair` |
| `pairingId` | 8B random | 本次配对标识，防重放 |
| `desktopEphPub` | 33B | 桌面临时 P-256 压缩公钥（配对后即废弃） |
| `qrSecret` | 16B random | 一次性 secret；手机用它认证桌面 |
| `issuedAt` / `expiresAt` | int64 | TTL 120s，过期必须重新生成 |
| `accountFingerprint` | 8B | `SHA-256(accountId)` 截断，**双端显示前 6 位**供人眼核对 |
| `relayHint` | 字符串 | 局域网 mDNS 名 / tailnet 名 / 中继端点，按优先级排列 |
| `flowHint` | 枚举 | `vault-key` / `approve` / `bind-phone`，让手机扫完立刻给出正确引导（同 CTAP `ga`/`mc`） |
| `caps` | bitmask | 手机可申请的权限（签名/解包/审批/只读） |

**② 配对握手（6 步）**

1. 桌面展示 QR + 6 位 `checkCode = Base10(SHA-256(payload)[0..2]) mod 10^6`（不足 6 位左侧补 0）。
2. 手机扫码 → 计算 `ECDH(phoneEphPriv, desktopEphPub)` → `K = HKDF-SHA256(secret, salt=qrSecret, info="dsh-pair-v1")`。
3. 手机经 LAN/Tailscale 连桌面（无 BLE 时）：发 `pairingId + HMAC(K, "phone-hello")`；桌面回 `HMAC(K, "desktop-ok" + pairingId)` —— 双方互认（呼应 CTAP 的"公钥认证客户端、secret 认证认证器"）。
4. **邻近性**：优先 BLE 广播（UUID 同 CTAP 风格，载荷用 K 加密）；无 BLE 则要求**双端 6 位码一致**并由人在两端确认（IETF 明确邻近性是首选缓解）。
5. 手机屏幕显示：账号指纹、桌面设备名 + 公钥指纹、申请能力、风险提示 → 用户生物识别确认。
6. 手机生成/使用**设备密钥**（首次在 SE/StrongBox 生成），签名配对 transcript；桌面校验签名 + attestation 后写入设备清单，并按架构 A/C 交换包裹的 DEK / share。

**③ 每次确认的签名覆盖字段（禁止布尔 approve）**

| 字段 | 说明 |
|---|---|
| `domain` | 固定 `DSH-APPROVAL-v1`，防跨协议重放 |
| `accountId` / `accountRole` | 身份与角色（子账号在此仍写子账号 id，角色信任由策略层判定） |
| `desktopDeviceId` / `phoneDeviceId` | 发起端 + 审批端 |
| `sessionId` / `challenge` | 会话标识 + 32B 一次性挑战 |
| `opType` | `vault.open` / `trust.raise` / `agent.exec` / `tx.sign` |
| `opDigest` | `SHA-256(canonical-CBOR(操作参数))` —— **桌面执行前必须复核一致** |
| `humanSummaryHash` | 手机上展示的可读摘要的哈希（防"展示与执行不一致"） |
| `riskLevel` / `issuedAt` / `expiresAt` | 高危操作 `expiresAt - issuedAt ≤ 60s` |
| `nonceCounter` | 每设备单调递增，服务端/桌面端做重放缓存 |

桌面验证规则：ES256 验签通过 + `challenge` 未用过 + `expiresAt` 未过 + `keyEpoch` 匹配 + `opDigest` 与"即将执行的操作"一致；任一不满足即 fail closed。

**④ 设备清单字段（UI 必展示 + 同步）**

`deviceId`(16B)、`displayName`、`platform`、`attestationType`(SE/StrongBox/TEE/none)、`pubKeyFingerprint`(SHA-256 → Base32 20 字符)、`role`(primary/companion/approver)、`trustLevel`、`capabilities`、`createdAt`、`lastSeenAt`、`keyExpiresAt`、`status`(active/revoked)、`revocationEpoch`、`pairedViaDeviceId`。

**⑤ 注销后本地如何失效（5 步，全部必须有）**

1. 注销设备：`account.keyEpoch += 1`，设备 `status=revoked`，记录 `revokedAt`。
2. 广播撤销：通过 P2P 推给所有在线设备；离线设备下次连上时收到 epoch 变化。
3. 删除密文：对端删除该设备对应的 `wrappedDEK`、缓存票据、会话密钥；若采用架构 C，重新分片/换 share。
4. 语义化拒绝：对被注销设备的请求返回 **`unlinked`（HTTP 410 语义）**，客户端必须**擦除本地包裹密钥并强制重新配对**，不得静默重试（抄 CTAP 2.2 状态辅助的 410 设计）。
5. 票据失效：所有由该设备签发或参与签发的短时票据（建议 TTL ≤ 5 分钟、单次使用）立即作废；桌面端验签时检查 `revocationEpoch` 一致。

**⑥ 信任等级公式（解决"子账号按主账号受信"）**

`effectiveTrust = min(accountRoleTrust, deviceAssuranceTrust, holderProofFreshness, sessionRisk)`

- `accountRoleTrust`：来自账号角色策略——**子账号登录时继承主账号的"身份层"信任策略**（这是唯一允许"继承"的维度）。
- `deviceAssuranceTrust`：来自 attestation（SE > StrongBox > TEE > 无）+ `BE=0` 才给最高。
- `holderProofFreshness`：本次签名的 `authAge`（建议 ≤ 300s），过期即降级。
- `sessionRisk`：来源网络、异常时间、并发会话等。
- **"手机号相同"不进入公式**，只进 `sessionRisk` 的提示项（例如"该号码近期发生过换卡"仅提示人工复核）。

## 9. 对我们设计的 8 条硬性建议
1. **手机号降级为弱信号**：只做联系与风控提示，禁止作为登录、恢复、审批因子；UI 明示"换号不影响钥匙"。
2. **确认动作必须是签名，不是布尔值**：签名覆盖 `opDigest` + 一次性挑战 + 短过期 + 单调计数器；桌面执行前复核摘要，杜绝"手机批准了 A、桌面执行了 B"。
3. **手机钥匙默认 device-bound**：iOS Secure Enclave / Android StrongBox，记录 attestation 与 `BE=0`；synced passkey 仅作恢复/只读，并在 UI 标注等级差异。
4. **配对只用临时材料**：QR 内仅临时公钥 + 一次性 secret + TTL ≤ 120s + 流程提示；必须有邻近性或双端 6 位码；长期密钥永不出现在二维码/日志里。
5. **设备清单 + 一键注销 + epoch 机制**：注销后所有对端 fail closed（410/unlinked 语义、擦除本地包裹密钥、旧票据作废），离线设备回连必须重新配对。
6. **通知必须可验证**：展示操作摘要、对象/金额、来源设备指纹、位置、时间 + 一次性数字挑战；生物识别不得有 passcode 回退；高危改动加延迟窗口（参考 Apple SDP 1 小时）。
7. **密钥分层与轮换**：DEK 随机 32B；KEK 由设备密钥/ PRF / 门限派生；DEK 仅在内存短暂存在；每次开柜后换 salt 或第二输入重包 DEK；绝不在手机明文存长期主密钥。
8. **恢复必须离线可演练**：恢复码 ≥128 bit（Base32 分组 + 校验和）+ 可选第三设备 shard；2-of-2 架构下没有第三 shard 就等于"双丢即死"；恢复动作本身走高危确认 + 延迟。

## 10. 关键来源（真实可访问，正文已内联引用）
| 主题 | 来源 |
|---|---|
| 规范 | [W3C WebAuthn L3](https://www.w3.org/TR/webauthn-3/) ｜ [FIDO CTAP 2.2](https://fidoalliance.org/specs/fido-v2.2-ps-20250714/fido-client-to-authenticator-protocol-v2.2-ps-20250714.html) |
| Passkey 定位 | [FIDO 白皮书](https://fidoalliance.org/white-paper-fido-authentication-for-moderate-assurance-use-cases/) ｜ [passkeys.dev 支持矩阵](https://passkeys.dev/device-support/) ｜ [PRF 支持实测](https://www.corbado.com/blog/passkeys-prf-webauthn) |
| 平台硬件 | [Apple 安全隔区](https://support.apple.com/guide/security/secure-enclave-sec59b0b31ff/web) ｜ [Apple 双重认证](https://support.apple.com/en-us/102660) ｜ [Apple 偷窃设备保护](https://support.apple.com/en-us/120340) ｜ [Android Keystore](https://developer.android.com/privacy-and-security/keystore) |
| 产品先例 | [Bitwarden 白皮书](https://bitwarden.com/help/bitwarden-security-white-paper/) ｜ [Bitwarden Log in with device](https://bitwarden.com/help/log-in-with-device/) ｜ [1Password Secret Key](https://support.1password.com/secret-key-security/) ｜ [YubiKey PIV](https://developers.yubico.com/PIV/Introduction/Certificate_slots.html) |
| 手机审批端 | [WhatsApp 多设备](https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/) ｜ [Signal 关联设备](https://support.signal.org/hc/en-us/articles/360007320771) ｜ [Telegram FAQ](https://telegram.org/faq#q-how-do-i-use-my-account-on-multiple-devices) ｜ [MS 号码匹配](https://learn.microsoft.com/en-us/entra/identity/authentication/how-to-mfa-number-match) ｜ [MS 无密码手机登录](https://learn.microsoft.com/en-us/entra/identity/authentication/howto-authentication-passwordless-phone) ｜ [Google prompts](https://support.google.com/accounts/answer/7026266) |
| 手机号风险 | [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html) ｜ [FBI IC3 SIM swap](https://www.ic3.gov/PSA/2022/PSA220208) ｜ [NYDFS Twitter 报告](https://www.dfs.ny.gov/Twitter_Report) ｜ [The Great SIM Heist](https://theintercept.com/2015/02/19/great-sim-heist/) ｜ [Terpin 判决](https://www.greenbergglusker.com/litigation/news/cryptocurrency-investor-michael-terpin-wins-75-8-million-judgment-in-first-ever-sim-swap-racketeering-case) |
| 跨设备协议安全 | [IETF Cross-Device Flows BCP](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-cross-device-security) |
| 恢复/门限 | [SLIP-39](https://github.com/satoshilabs/slips/blob/master/slip-0039.md) ｜ [FROST RFC 9591](https://www.rfc-editor.org/rfc/rfc9591.html) ｜ [Vitalik 社交恢复](https://vitalik.eth.limo/general/2021/01/11/recovery.html) ｜ [Signal SVR](https://signal.org/blog/secure-value-recovery/) |
| 网络层信任 | [Tailscale auth keys](https://tailscale.com/docs/features/access-control/auth-keys) ｜ [key expiry](https://tailscale.com/docs/features/access-control/key-expiry) ｜ [tags](https://tailscale.com/docs/features/tags) ｜ [tailnet lock](https://tailscale.com/docs/features/tailnet-lock) |
