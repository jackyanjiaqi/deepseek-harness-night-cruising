# native / JLC acceleration

`jlc.node` is the napi-rs build of `jsonl-native-compress/test/bindings/napi`.
The controller loads `native/jlc-<platform>-<arch>.node` first, then
`native/jlc.node`. Standard DSH never loads it; Night Cruising loads it only
when the persisted intent is enabled.

This checkout contains a macOS arm64 build for local verification. A release
must replace it with the matching platform build (or the `@dsh/jlc` platform
package), and sign/notarize the Mach-O on macOS. Keep the Rust core and this
binding at the same version.
