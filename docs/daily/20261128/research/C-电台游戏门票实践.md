# C｜电台与小游戏「门票」机制外部调研笔记

## 结论摘要

1. **最值得抄①：票根不动、入场凭证高频轮换。** Ticketmaster SafeTix 每 15 秒换一次码、Google Wallet RotatingBarcode 用 TOTP 每分钟换码，截图当场失效；而票根（ticket_id）本身不变，吊销仍是单点操作。
2. **最值得抄②：批次 × 单码双层吊销 + 首发绑设备。** 批次维度可整批回收（Ubisoft 批量吊销黑卡密钥），单码维度可踢一个人（Discord 邀请 max_uses/到期），首次入场绑设备后才可续用（SafeTix「票自动存到你这台设备」）。
3. **最值得抄③：名单制兜底，码只是搬运工。** Steam Playtest 按账号授权、Google Play 按邮箱名单、Netflix 按「同住网络」；码/链接只负责把授权搬到对方手里，把码当唯一凭据必然被转卖。
4. **最该避开的坑①：静态码/截图当票。** Clubhouse 邀请码在 eBay 炒到 50~415 美元，Eventbrite 大量票仍是静态 QR；静态凭证 = 可无限复制、无法追责。
5. **最该避开的坑②：无限次、无到期、无验证的公开链接。** TestFlight 公开链接需在满员时主动关闭；Discord 公开邀请被爬虫抓走后短时涌入数百机器人。必须 max_uses + 到期 + 限流 + 一键停用。

> 2026-11-28 · 调研员 res-radio-game · 方法：web_search / web_fetch 抓取当天可访问的一手文档与新闻，链接即出处；二手总结已标注。只研究「机制形状」，不记录任何绕过/伪造手法。

## 0. 一句话框架

门票系统的本质不是「一串口令」，而是四件事的组合：**(a) 凭据形态**（静态码 / 短时签名 / 轮换 TOTP）、**(b) 绑定对象**（无 / 账号 / 设备 / 同住网络 / 在场证明）、**(c) 撤销粒度**（单码 / 批次 / 全员换钥匙）、**(d) 平台侧限流**（次数、名额、速率、并发）。下面所有表格都按这四列来读。

## 1. 游戏 / 软件测试入场：码、名单、名额

| 产品/机制 | 码的形态 | 次数 / TTL | 绑定什么 | 撤销方式 | 可借鉴点 |
|---|---|---|---|---|---|
| [Steam Playtest](https://partner.steamgames.com/doc/features/playtest) | 无码：商店页「请求访问」按钮 | 开发者设定同时可参与人数上限，可随时改为全开放 | Steam 账号与库内 entitlement | 关闭 playtest、下调名额 | 只授「权限」不发「码」，零转卖风险（[PCMag 报道](https://www.pcmag.com/news/steam-playtest-gives-developers-a-free-way-to-test-games-with-players)） |
| Steam Playtest 好友邀请（阶段性） | 参与者内推邀请 | 每人最多 3 人；仅限已成好友 ≥30 天；文档示例按「当前有权限人数×3」封顶（5,000 人→15,000 邀请） | 好友关系 | 关闭邀请开关 | 老带新要加关系门槛 + 总量上限 |
| [Steam keys](https://partner.steamgames.com/doc/features/keys)（beta/Release State Override） | 一串 CD-Key | 用于 beta 用途全站上限约 2,500 个 | Steam 账号，激活后入库 | Ban/Disable keys 页批量吊销 | 码制必须内置「批量吊销」通道 |
| [Steam Guest Pass](https://store.steampowered.com/oldnews/1037)（历史） | 库存式通行证，发好友 | 激活后 3 天可玩；每 30 天补发 1 张；每人 1 张 | 收件好友账号 | 到期自动失效 | 短期试玩 + 定期补发，天然控量（[2013 关闭测试公告](https://store.steampowered.com/oldnews/871)） |
| [Apple TestFlight 邮箱邀请](https://developer.apple.com/testflight/) | 邀请邮件 + 兑换 | 构建上传后 90 天不可用；外部测试者 ≤10,000 人 | Apple ID | 移除测试者 / 停用构建 | 「构建过期」比「码过期」更硬（[ASC 帮助](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)） |
| [TestFlight 公开链接](https://developer.apple.com/testflight/) | 一个公开 URL，可设设备/OS 条件 | 直到关闭或满员；内部测试者 ≤100 人、每人 ≤30 台设备、≤100 个构建 | 任何拿到链接者 | 满员后手动停用链接 | 公开链接必须有「满员即关闭」开关 |
| [Google Play 内部测试](https://support.google.com/googleplay/android-developer/answer/9845334) | 邮箱名单 | 上限约 100 名测试者（[第三方文档](https://help.adalo.com/publishing-apps/publishing-to-the-google-play-store/upload-your-build-file-to-google-play-listing) 口径） | Google 账号 | 移出名单 | 小范围内部人最省事 |
| Google Play 封闭测试 | 邮箱名单 / Google Groups | 官方称 Groups 无人数上限；第三方文档记 200 个名单、每名单 2,000 邮箱（[第三方](https://help.adalo.com/publishing-apps/publishing-to-the-google-play-store/upload-your-build-file-to-google-play-listing)） | Google 账号 | 移出名单 / 换轨道 | 名单制承载「大量测试玩家」 |
| [Xbox Insider](https://support.xbox.com/en-US/help/account-profile/manage-account/xbox-insider-program) | 无码：Insider Hub 里 Previews → Join | 预览长期开放，随构建更新 | Microsoft 账号（需 18+ 同意条款） | 退出预览 | 订阅式预览，非发码（[接入步骤](https://support.subnautica.com/hc/en-us/articles/60749976367385-What-are-the-requirements-to-participate-on-Xbox)） |
| [itch.io 受限页面](https://itch.io/t/4552485/restricted-access-not-working-and-download-keys-require-account) | 单一页面密码 / 下载密钥 | 改密码后旧密码立即失效；密钥可逐条撤销 | 项目页本身（密钥可绑账号） | 改密码；逐个撤销 key | 密码适合一次性活动，密钥适合长期授权 |
| [Discord 服务器邀请](https://discord.com/developers/docs/resources/invite) | 邀请链接（可自定义） | max_age 秒（0=永不过期）、max_uses（0=无限）、temporary 临时成员 | Discord 账号 + 服务器 | 删除邀请；踢人；临时成员未获角色会被移出 | 「次数 + 期限 + 临时成员」三件套（[字段说明](https://registry.terraform.io/providers/edw1nzhao/discord/latest/docs/resources/invite)） |
| [Minecraft 白名单](https://minecraft.wiki/w/Server) | 账号名列表（whitelist.json） | 长期；可热加载 | 正版账号名 | `/whitelist remove`、`enforce-whitelist` | 名单热更新无需重启（[allowlist 命令](https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/allowlist)） |

**这一节的三个硬结论：** ①「大量测试玩家」几乎没人用裸码，都是名单/账号授权 + 名额上限；②平台给的撤销手段普遍是「按批次 + 按人」两档，不是「改个密码全员重来」；③**过期是平台侧强制的**（TestFlight 90 天、Steam beta key 上限），不依赖开发者自觉。

## 2. 账号共享与「同住/同域」判定：额度怎么算、怎么误伤

| 产品/机制 | 共享额度 | 「同住/同域」判定 | 误伤与绕过 | 可借鉴点 |
|---|---|---|---|---|
| [Netflix 家庭](https://www.slashgear.com/1714284/why-netflix-says-device-not-part-of-household-how-fix/) | 同户共享；非同住需「付费共享」加购 | 以「主位置电视所连网络」为锚，同路由器下的设备视为同户；每月可更新主位置的次数有限；异地可「我在旅行」临时观看（约 14 天） | 误伤：出差/宿舍/双城生活；绕过：VPN、频繁改主位置 | 首次绑「锚设备/锚网络」，之后低频复核 + 宽容期（[TheStar](https://www.thestar.com.my/tech/tech-news/2025/08/10/opinion-how-to-stream-netflix-from-a-second-location)、[BBC](https://www.bbc.com/news/business-66240390)） |
| [Spotify Duo/Family](https://www.heise.de/en/news/Routine-improvement-Spotify-explains-Premium-plan-rules-11498505.html) | Duo 2 人 / Family 6 人 | 新增「同住验证」：成员扫动态二维码，**两人必须同时在同一地点**才算通过 | 未按期验证 → 12 个月内不得再加入家庭/Duo 计划 | 用「同时在场」证明同住，比 IP 更硬（[中文报道](http://www.163.com/dy/article/JK31ON040516UGI2_pdya11y.html)） |
| 网易云音乐「一起听」/共享特权 | 一起听房间最多 6 人；共享特权最多 2 个账号共用 1 个 VIP | 宣称需同一家庭/生活单位，靠同一支付账户 + 协议约束，技术校验弱 | 拼车容易绕过 | 弱校验层不要承载高价值权限（[一起听](https://m.php.cn/faq/2238783.html)、[共享特权](http://www.163.com/dy/article/JK31ON040516UGI2_pdya11y.html)） |
| [Clubhouse House 会员](https://support.clubhouse.com/hc/en-us/articles/20199097681043-Managing-Houses) | 每个 House 自定；邀请制与候补审批二选一 | 没有同住概念，只靠邀请链 | 邀请码可自由转卖（见 §6） | 邀请制若不绑身份，必然长出黄牛市场 |

**给 DSH 的判断：** 「同住/同域」在 P2P 场景里不可靠也不该做硬校验——DSH 用户会在局域网、Tailscale、手机热点之间漫游。可以抄的是**「首次绑定 + 低频复核 + 宽容期」**这个节奏：首次入场绑设备，之后只在「异常并发/异地同时在线」时复核，其余放行。Spotify 的「同时在场扫码」在电台场景可降级为「主办方现场播报一个 30 秒口令」，用于高价值场次。

## 3. 电台 / 直播 / 演唱会：听众授权与票根轮换

| 产品/机制 | 凭证形态 | 有效期 / 次数 | 绑定 | 撤销 / 踢出 | 可借鉴点 |
|---|---|---|---|---|---|
| [Cloudflare Stream 签名 URL](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/) | URL 内签名 token | `/token` 默认 1 小时，可自定义 exp；签名密钥自签不受 API 限流 | 可加 accessRules（国家/IP）、可关下载 | 吊销签名密钥、改视频为私有 | 媒体地址本身就是凭证，所以 TTL 要短（[限流说明](https://developers.cloudflare.com/fundamentals/api/reference/limits/)） |
| [Akamai EdgeAuth](https://docs.player.akamai.com/amp-web-sdk/latest/amp-core/05-authorization.html) | URL 追加 hdnts/hdnea（st/exp/acl/hmac） | exp 到期即失效；播放器按 expiration 主动换 token | ACL 限定可访问路径 | 换密钥 / 改 ACL | 「过期前再换一张」，观众无感 |
| [私人播客 RSS](https://help.podigee.com/article/375-protected-podcasts) | 每人一条带 token 的 feed URL | 长期有效，可随时换 token | feed token 本身 | 换 token / 停用 feed | 没有客户端也能做「一人一链」 |
| [YouTube 会员专属视频](https://support.google.com/youtube/answer/14917424) | 账号权限位 | 随会员期 | 频道会员等级 | 取消会员 | 权限位在服务端，最稳（[设置会员等级](https://support.google.com/youtube/answer/7544492)） |
| [Discord Stage 频道](https://browse.dgit.debian.org/python-discord.git/tree/discord/member.py?id=32ee3935adcc8da80f26fbb12f951569e2b39a4a) | 服务器角色 + 举手请求 | 场次内 | 账号 + 角色 | 移出频道 / 撤角色 | 听众默认静音，举手获批才发言 |
| [Zoom Webinar 注册](https://developers.zoom.us/docs/isv/workflows/create-meeting-reg.md) | 每人唯一 join_URL | 绑定该场次 | 注册身份（可要求登录或邮箱 OTP） | 移出参会者 | 一人一链可精确踢人 |
| [Ticketmaster SafeTix](https://help.ticketmaster.ca/hc/en-us/articles/26584359203473-Why-do-my-tickets-have-a-moving-barcode) | App 内 PDF417，每 15 秒刷新 | 每帧 15 秒；票本身在场次期有效 | 票 + 设备（查看后「自动存到你这台设备」）；「截图进不去」 | 取消/重发票、限制转移 | **票根不变、入场凭证高频轮换**，单点吊销仍然成立（[产品说明](https://business.ticketmaster.com/harness-the-power-of-safetix-in-2025/)） |
| [Google Wallet RotatingBarcode](https://developers.google.com/wallet/tickets/events/resources/rotating-barcodes) | TOTP 轮换条码 | 通常每分钟变一次，扫描端只接受最新 | 票 + 设备/钱包 | 作废票 | 标准 TOTP 即可实现，兼容 Apple/Google 钱包（[RFC 6238](https://datatracker.ietf.org/doc/html/rfc6238)） |
| Eventbrite（多数场次） | 静态 QR | 长期 | 票 | 取消订单 | 反面教材：静态码可截图转卖（[第三方评述](https://neatpass.app/learn/concert-ticket-screenshot-wont-scan)） |

**可加工成 DSH 的三个模式：** 短时签名 URL（Cloudflare/Akamai 做法，适合把「听」当作流）、一人一链（Podigee/Zoom 做法，适合精确踢人）、票根轮换（SafeTix/Google Wallet 做法，适合防截图转卖）。三者在实现上可以叠加：**ticket_id 永久 + 每 30 秒派生一个入场 token + 单场单设备**。

## 4. 「不记名但可追责」的六个抓手

| 抓手 | 做法 | 真实参照 | 代价 / 注意 |
|---|---|---|---|
| 批次前缀 | 码内嵌 batch_id，泄露可定位到发放渠道/人群 | Steam key 批次、Ubisoft 按批次吊销 | 码变长，需容错输入 |
| 单码 ID | 每码唯一 ID，服务端或签名可验证状态 | Discord 邀请按条删除 | 需状态同步（P2P 下用撤销列表同步） |
| 设备首绑 | 首次入场登记设备公钥，之后必须同钥 | SafeTix「票存到这台设备」 | 换机要申诉通道 |
| 次数与并发 | max_uses=1、并发座位=1 | Discord max_uses；Zoom 一人一链 | 家庭/多端体验变差 |
| 速率限制 | 每 IP/设备/码 单位时间尝试次数 | Cloudflare `/token` 端点限流 | 需要网关或房间侧计数 |
| 行为风控 | 同码多 IP 同时在线即挂起待审 | Netflix 同住判定 | 会误伤，需人工复核队列 |
| 画面水印 | 画面叠 ticket_id，泄露可追溯 | 票务/流媒体行业惯例 | 影响观感，需淡显 |

**关键设计原则：匿名 ≠ 不可追责。** 用户无需注册账号（不记名），但每张票有唯一 ID + 批次 + 设备指纹；一旦发现转卖，能定位到「哪一批、哪张、哪台设备」，并对该码单点吊销——这就是 Clubhouse 式邀请制失败、而 Ticketmaster 式票根制成立的分水岭。

## 5. 无中心服务器 / P2P 场景：限时房间怎么搭

| 机制 | 在无中心鉴权时怎么用 | 限制 / 注意 | 可借鉴点 |
|---|---|---|---|
| [WireGuard PresharedKey](https://manpages.debian.org/testing/wireguard-tools/wg.8.en.html) | 每对 peer 额外混入 256 位 PSK（`wg genpsk`），与公钥加密叠加 | 可选；轮换需双方同时更新；空文件=删除 | 把 PSK 当「房间口令」：换 PSK = 换门票（[轮换实践](https://github.com/AnixOps/anix-control/blob/v4.1.0/docs/guide/wireguard-key-rotation.md)） |
| WireGuard 密钥轮换 | 重新生成私钥/公钥/PSK，按 peer 增量更新，`syncconf` 不打断现有会话 | 需要可靠分发通道 | 活动结束一键换密钥，旧票全废 |
| [Matrix join rules](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/3386-unified-join-rules.md) | public / invite / knock / restricted；knock = 申请入场由房内人批 | 需要 homeserver | knock 模式很适合「申请制听众」（[spec](https://spec.matrix.org/latest/client-server-api/#guest-access)） |
| [Jitsi token 鉴权](https://jitsi.github.io/handbook/docs/devops-guide/token-authentication/) | 房间创建须 JWT（moderator/exp 在 token 里），观众走匿名 guest 域；`muc_wait_for_host` 让房间等人，`persistent_lobby` 锁门 | 需自建 prosody/jicofo | 「主持人先到、门才开」；角色由 token 声明（[JWT claims](https://github.com/8x8cloud/public-developer-docs/blob/bdf57b70151122fec57f53b993ef33e75e11bff2/docs/jaas/docs/api-keys-jwt.md)） |
| [Mumble access token](https://wiki.mumble.info/wiki/Murmurguide) | 每个频道一个口令式 token，成员自行添加 | 频道级而非房间级 | 口令分发即授权 |
| [Mumble TempLink 插件](https://github.com/Solar-Helix-Independent-Transport/allianceauth-mumble-temp) | 生成临时链接，兑换者进 Guest 组，受 ACL 限制；`!kicktemps` 一条命令清场 | 需要 Alliance Auth 生态 | **「临时链接 + 一条命令批量清场」正是 P2P 活动需要的** |
| [TeamSpeak privilege key](https://github.com/DomeNinchen/ts6forkmanager/wiki/Tokens-and-Passwords) | 一次性密钥，兑换即授予组权限 | 兑换后立即删除，难回收 | 「用完即焚」最省心 |
| [Minecraft whitelist](https://minecraft.wiki/w/Server) | 名单文件 + 热加载 | 需能改服务端文件 | 小规模最可靠的仍是名单制 |

**P2P 可行组合（无需中心鉴权服务器）：** 主办方离线签发「组织者签名票据」（Ed25519）→ 终端本地验签 + 检查时间窗与名额 → 入场后由主办方派生并分发**组密钥（group key）**，每隔 N 分钟轮换一次 → 踢人 = 换组密钥 + 广播新密钥（被踢者拿不到）+ 把 ticket_id 加入签名撤销列表（gossip 传播，带单调版本号）。WireGuard PSK 轮换与 Mumble TempLink 是这个模型的现成参照。

## 6. 五个真实事故 / 滥用案例

| 事故 | 发生了什么 | 根因 | 后来加了什么限制 |
|---|---|---|---|
| [Ubisoft Far Cry 4 密钥吊销](https://www.eurogamer.net/it-looks-like-ubisoft-is-going-after-third-party-key-sellers)（2015） | 盗刷信用卡购 key，经 G2A/Kinguin 转卖，Ubisoft 批量吊销，玩家库中游戏消失 | 码可批量采购再转卖；来源不可验 | 发行商「定期吊销欺诈所得 key」；渠道侧风控（[Escapist](https://www.escapistmagazine.com/psa-ubisoft-is-revoking-far-cry-4-cd-keys-from-3rd-party-re-sellers-update-2/)、[G2A 回应](https://gamegrin.com/news/g2a-respond-to-ubisoft-revoking-keys)） |
| [Ticketmaster SafeTix 被逆向](https://blog.rottenwifi.com/how-ticketmasters-safetix-barcode-was-reverse-engineered-to-enable-resales-elsewhere/)（2024） | 研究者还原 15 秒轮换码的生成逻辑，broker 在第三方交付层「重放」真票，部分可过闸 | 客户端持有票数据与密钥；轮换只防截图、不防提取 | 官方强调须在 App/Wallet 内查看；DOJ 反垄断案也盯上转移限制（[404 Media](https://www.404media.co/scalpers-are-working-with-hackers-to-liberate-non-transferable-tickets-from-ticketmasters-ecosystem/)、[Engadget](https://www.engadget.com/hackers-reverse-engineer-ticketmasters-barcode-system-to-unlock-resales-on-other-platforms-194826061.html)、[DOJ 诉状](https://www.justice.gov/opa/media/1364366/dl?inline=)） |
| [Clubhouse 邀请码转卖](https://technode.com/2021/02/02/clubhouse-invites-for-sale-on-alibabas-used-goods-app/)（2021） | 邀请稀缺，eBay 一条炒到 50~415 美元，闲鱼/淘宝同样有售 | 邀请可自由转让、无身份绑定、无批次追溯 | 邀请绑手机号/通讯录关系，限制邀请链 |
| [Discord 公开邀请被爬 → raid](https://www.shieldmylinks.com/blog/discord-raid-protection) | 公开邀请被 server-list 站点与 raid 频道抓取，凌晨短时数百 bot 涌入刷屏 | 链接无次数、无到期、无入群验证 | 服务器验证等级、max_uses/过期、反 raid 工具（[行业观察](https://inviter.co/discord)） |
| [Netflix 共享拉闸](https://www.bbc.com/news/business-66240390)（2023） | 同住判定上线，非同住需加购，短期争议后订阅增长 | 共享边界无法用单一信号判定 | 「主位置 + 设备网络 + 旅行宽限」组合，而非单一 IP |

**三个可迁移的教训：** ①**能批量发的码必须能批量吊销**（Ubisoft）；②**轮换只能挡住截图，挡不住拿到种子的人**（SafeTix 被逆向）——所以种子要留在主办方/房间侧，客户端只拿派生结果；③**稀缺 + 可自由转让 = 黄牛**（Clubhouse），DSH 的口令若是一次性活动票，务必绑设备或现场口令。

## 7. 两套可直接落地的「门票」设计草案

### 7.1 草案①：测试玩家批次票（多人、长 TTL、可续期）

**字段（票据 = 组织者签名的 JSON/CBOR）：**

| 字段 | 示例 | 说明 |
|---|---|---|
| `batch_id` | `BT-2026-11-28-A` | 批次号，印在码里；整批回收用 |
| `ticket_id` | `T-7K3M9QX2-00042` | 单码唯一 ID，踢人/审计用 |
| `code` | `DSH7K3M9QX2-00042-9F1C` | 可读口令（Crockford Base32 + 4 位校验），用户输入用 |
| `entitlement` | `test-room, mini-game-alpha` | 有限功能位掩码 |
| `not_before` / `expires_at` | 2026-11-28 / 2026-12-28 | 长 TTL（默认 30 天），可续期 |
| `max_uses` / `max_concurrent` | 0（不限）/ 1 | 测试玩家允许多端，坐席按并发限 |
| `bind_mode` | `device-soft` | 首绑设备公钥，换机需重新申请 |
| `device_pubkey` | `ed25519:...` | 首次入场后回填 |
| `epoch` | `3` | 房间密钥世代；换 epoch 即全批失效 |
| `issuer_sig` | `ed25519:...` | 组织者私钥签名，任何终端可离线验签 |
| `revoked_at` | `null` | 单码吊销时间戳 |

**签发流程：** ①主办方在面板建批次，填功能位、TTL、人数上限；②生成本批次种子 `K_batch`，按 `code = HMAC(K_batch, ticket_id)` 派生码，**私钥只在主办方设备**；③把「批次公钥 + 撤销列表版本」发到测试服房间；④导出 CSV / 二维码包 / 一链一码链接，分发给测试玩家；⑤玩家首次进入输入 code → 终端验签 + 检查时间窗 → 登记设备公钥；⑥续期 = 同 batch 下改 `expires_at` 并重新签名，无需换码。

**校验点（房间侧，每次入场）：** ①code 校验位；②`issuer_sig` 验签；③`not_before ≤ now ≤ expires_at`（允许 ±5 分钟时钟漂移）；④`ticket_id ∉ 撤销列表` 且批次未整批吊销；⑤并发 ≤ `max_concurrent`；⑥设备公钥匹配（首绑后）。

**踢人 / 回收（四种粒度）：** ①**单人**：把 `ticket_id` 写入撤销列表，广播增量（带版本号，防旧列表重放）；②**整批**：`batch_id` 拉黑，一次回收所有测试玩家；③**全员**：`epoch + 1`，房间组密钥轮换，所有旧票失效（活动结束用这个最干净）；④**到期**：TTL 到点自动失效，客户端本地也能判定，不依赖在线。

**防转卖：** 码内嵌批次与序号便于溯源；高风险场次把 `max_uses` 设为 1 并强制设备首绑；画面/日志带 `ticket_id` 水印；同码多设备并发触发复核队列。

### 7.2 草案②：电台单场演出票（一人一码、两小时、入退场）

**字段：**

| 字段 | 示例 | 说明 |
|---|---|---|
| `event_id` / `room_id` | `EV-20261128-2200` / `radio-42` | 场次与房间 |
| `ticket_id` | `S-000871` | 一人一码，不记名但可追 |
| `holder_hint` | `观众871`（可空） | 显示名，主办方可见「谁在场」 |
| `valid_from` / `valid_to` | 21:30 / 24:00 | 开场前 30 分钟入场，散场即失效 |
| `burn_after_join` | `true` | 入场即核销（退场可重入但不换人） |
| `device_pubkey` | `ed25519:...` | 首入绑定，一码一设备 |
| `totp_seed` | 由 `event_secret` 派生 | 每 30 秒派生入场 token（防截图） |
| `group_key_epoch` | `5` | 媒体组密钥世代，踢人即 +1 |
| `issuer_sig` | `ed25519:...` | 主办方签名 |

**签发流程：** ①主办方建场次，设容量 N、时间窗、是否允许退场重入；②生成 `event_secret` 与 N 个 `ticket_id`，导出为票包（二维码/链接）；③分发（群发私聊、线下扫码）；④开场前主办方上线，房间进入 lobby 状态等待 host。

**校验与入场（P2P 无中心服务器）：** ①观众出示 `ticket_id + 当前 30 秒 TOTP`；②主办方终端验签、查 `ticket_id` 未核销、TOTP 在 ±1 步内、时间窗内；③核销并回一个**短期入场凭证**（含 `session_key`、过期 2 分钟）；④主办方把该 peer 加入媒体组并下发当前 `group_key`；⑤每 5~10 分钟轮换组密钥，旧密钥成员需重新握手续期——**「续不上就是被踢了」**，无需额外通知。

**入退场 / 踢人 / 回收：** ①退场释放坐席但 `ticket_id` 仍绑定设备，可重入；②踢人 = 从 peer 列表移除 + `group_key_epoch + 1` 并只把新密钥发给留下的人 + 把 `ticket_id` 写进场次撤销列表；③活动结束 = `epoch` 再 +1 + 场次关闭，全部票同时失效；④对可疑转卖 = 单码吊销 + 该设备指纹列入观察名单。

**防截图与防转卖的现实边界：** 屏幕录制/翻拍无法根除（SafeTix 被逆向就是证明），能做实的是：每 30 秒换入场 token（截图立刻过期）、一码一设备、一码一并发、画面叠 `ticket_id` 水印、异常并发的复核队列。**目标不是「绝对防不住」，而是「转卖成本高于票价」**。

## 8. 映射回 DSH

| DSH 现有形态 | 映射到本调研的机制 |
|---|---|
| 「子账号 + 口令」入口 | code + `ticket_id`（§7 两套字段表） |
| 电台房间（局域网/Tailscale） | `room_id` + `group_key_epoch` + 撤销列表 gossip（§5） |
| 小游戏（底栏插件） | `entitlement` 功能位掩码，与票解耦 |
| 主办方批量发码 | 批次 + 种子派生 + CSV/二维码导出（§7.1） |
| 看谁在场 / 随时踢人 | 在场表 = 已核销 ticket + 设备指纹；踢人 = 撤销 + 换组密钥（§7.2） |
| 活动结束全部回收 | `epoch + 1` 或整批拉黑（§7.1 第③④种粒度） |
| 防转卖防外传 | 单码 TTL 短 + 设备首绑 + 并发=1 + 水印 + 速率限制（§4） |

## 9. 关键来源索引

- 测试入场：Steam [Playtest](https://partner.steamgames.com/doc/features/playtest) / [Keys](https://partner.steamgames.com/doc/features/keys)、[TestFlight](https://developer.apple.com/testflight/)、[Google Play 测试](https://support.google.com/googleplay/android-developer/answer/9845334)、[Xbox Insider](https://support.xbox.com/en-US/help/account-profile/manage-account/xbox-insider-program)、[Discord 邀请对象](https://discord.com/developers/docs/resources/invite)、[Minecraft 白名单](https://minecraft.wiki/w/Server)
- 同住判定：[Netflix 家庭](https://www.slashgear.com/1714284/why-netflix-says-device-not-part-of-household-how-fix/)、[Spotify 同住验证](https://www.heise.de/en/news/Routine-improvement-Spotify-explains-Premium-plan-rules-11498505.html)
- 直播/演出：[Cloudflare Stream](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/)、[Akamai EdgeAuth](https://docs.player.akamai.com/amp-web-sdk/latest/amp-core/05-authorization.html)、[SafeTix 帮助](https://help.ticketmaster.ca/hc/en-us/articles/26584359203473-Why-do-my-tickets-have-a-moving-barcode)、[Google Wallet RotatingBarcode](https://developers.google.com/wallet/tickets/events/resources/rotating-barcodes)、[私人播客 RSS](https://help.podigee.com/article/375-protected-podcasts)
- P2P 限时房间：[WireGuard wg(8)](https://manpages.debian.org/testing/wireguard-tools/wg.8.en.html)、[Jitsi token 鉴权](https://jitsi.github.io/handbook/docs/devops-guide/token-authentication/)、[Mumble 访问令牌](https://wiki.mumble.info/wiki/Murmurguide)、[TeamSpeak 一次性密钥](https://github.com/DomeNinchen/ts6forkmanager/wiki/Tokens-and-Passwords)
- 事故：[Ubisoft 吊销](https://www.eurogamer.net/it-looks-like-ubisoft-is-going-after-third-party-key-sellers)、[SafeTix 逆向](https://blog.rottenwifi.com/how-ticketmasters-safetix-barcode-was-reverse-engineered-to-enable-resales-elsewhere/)、[Clubhouse 邀请转卖](https://technode.com/2021/02/02/clubhouse-invites-for-sale-on-alibabas-used-goods-app/)、[Discord raid](https://www.shieldmylinks.com/blog/discord-raid-protection)
