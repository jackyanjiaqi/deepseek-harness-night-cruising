# Linux 打包：成品冒烟 Office 引擎误判（2026-11-23）

## 结论

Linux 的 tar.gz / deb / AppImage 都能构建且可运行，但 `npm run release` 的最后一步（`smoke-packaged-runtime.ts` → docx 转换）失败，release 命令因此返回失败。产物由同一批 electron-builder 输出按 release 收尾规则手动落盘：

- `dist/night-cruising-0.2.2-rc.5-linux-x64.tar.gz` + `.sha256`
- `dist/night-cruising-0.2.2-rc.5-linux-x64.deb` + `.sha256`
- `dist/night-cruising-0.2.2-rc.5-linux-x64.AppImage` + `.sha256`

已验证：deb 用 `dpkg-deb -x` 解包后 `night-cruising` 正常起窗，内置 CLI 报 `0.2.2-rc.5`；AppImage 直接运行可起 `dsh web`；两者图标均为标准 `hicolor/512x512`。

## 打包改动（本次新增）

- 补丁 `009-linux-deb-appimage.patch`：`linux.target` 增加 `deb`、`AppImage`，写入 512 图标、maintainer（可用 `DSH_DESKTOP_LINUX_MAINTAINER` 覆盖）、`synopsis`，并在 `extraMetadata.homepage` 提供 fpm 必需的项目主页。
- 补丁 `010-linux-icon.dir.patch`：新增 `resources/icon-linux-512.png`（由 1104×1104 的 `icon.png` 缩放，避免非标准尺寸目录被图标主题忽略）。
- `patches/tools/release.mjs`：`nativeTarget()` 改为返回多个格式，逐个复制到 `dist/` 并生成 `.sha256`。
- `scripts/site-release.mjs`：站点目录仍只登记每平台一个包（Linux 为 tar.gz），deb/AppImage 只做校验、不进下载页；`site:test` 覆盖该行为。
- `patches/tools/cruise.test.mjs`：目标与配置断言同步到三格式。

## 失败信息

```
desktop runtime: docx conversion failed: OfficeKitError:
Installed LibreOfficeKit package is incomplete:
@deepseek-ai/libreoffice-kit-linux-x64-glibc. Reinstall the package.
  [cause] Cannot find module '@deepseek-ai/libreoffice-kit-linux-x64-glibc/package.json'
```

抛错点：`@deepseek-ai/dsh-office-kit` 的 `createEnginePackageResolver()`；
`fromKit.resolve.paths(name).some(dir => lstatSync(join(dir, name), { throwIfNoEntry: false }) !== undefined)`
判定为真，于是拒绝回退到 wasm。

## 已排除的事实

- 官方 `@deepseek-ai/libreoffice-kit@0.2.2` / `0.2.3` 的 `optionalDependencies` 都不含 Linux 原生引擎，Linux 设计上使用 `libreoffice-kit-wasm`。
- `app.asar`、`app.asar.unpacked/dsh/node_modules/@deepseek-ai/`、pnpm store、构建树 `.build/.../dsh/node_modules/@deepseek-ai/` 均不存在 `libreoffice-kit-linux-x64-glibc`（asar 头里也没有该空目录条目）。
- 同一台机器上，未打包的 dsh 树冒烟里 docx/xlsx/pptx 转换是**通过**的，只有 asar 内解析失败。
- `strace -ff -e trace=statx,newfstatat` 未见 Host 进程对该名字发过 statx，说明判定发生在 asar 虚拟文件系统层而不是真实文件系统。

## 复现

```bash
export PATH=~/.nvm/versions/node/v24.18.0/bin:$PATH
export LD_LIBRARY_PATH=~/.cache/nc-glib280   # 见下一节；否则 sharp 冒烟会 SIGSEGV
cd apps/desktop/.desktop-build/../../ 2>/dev/null
cd .build/harness-<digest>/apps/desktop
DSH_DESKTOP_TARGET_PLATFORM=linux DSH_DESKTOP_TARGET_ARCH=x64 \
DSH_DESKTOP_UNSIGNED=1 DSH_DESKTOP_APP_ID=org.nightcruising.harness \
pnpm exec tsx scripts/smoke-packaged-runtime.ts --unsigned
```

## 本机构建环境的两个前置条件（与本问题无关）

1. glib 2.88（Ubuntu 26.04）与 sharp 自带静态 libvips 混用会让 payload 冒烟 SIGSEGV（gdb 栈落在系统 `g_object_unref`）。用 core24 的 glib 2.80 目录做 `LD_LIBRARY_PATH` 后冒烟全绿。
2. 本机无 `musl-gcc` 且无 root，`native/system` 的 `landlock-run` 与 musl flock addon 无法编译；改为取官方 `@deepseek-ai/node-addon-system-linux-x64@0.1.2` 预构建 `bin/`，`verify-launcher-binary` 通过。

## 待办

- 定位 `dsh-office-kit` 在 asar 下把「不存在的引擎目录」判定为存在的具体原因（怀疑 Electron asar `lstatSync` 语义或解析基路径），修复后 `npm run release` 即可完整通过。
- 验证 Linux 端 Office 转换在成品里是否真正回退到 wasm。
