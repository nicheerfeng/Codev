# Third-party references for the Agent Host rebuild

## Picot

The Rust Agent Host architecture, including native Pi process supervision, instance-scoped coordination, device pairing and the shared desktop/remote service boundary, was developed with reference to Picot:

- Repository: <https://github.com/hello-kukoo/picot>
- Reviewed revision: `82691e8a283f0389945aa9d8e21c29ad8d480231`
- Relevant reference files: `pi_rpc_bridge.rs`, `runtime_coordinator.rs`, `native_pi_manager.rs`, `acp_manager.rs`, `host_server.rs`, `remote_auth.rs`.

The upstream MIT license notice is reproduced below for attribution and preservation with any adapted portions.

> MIT License
>
> Copyright (c) 2026 Shixin Guo
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Codeg

- Repository: <https://github.com/spacering-net/codeg>
- Reviewed revision: `4991406e6045b7903ae2c5bc78db0d3b7dfd1f77`
- License: Apache License, Version 2.0.

Codeg was consulted for agent registration, standalone-service separation, authenticated WebSocket clients and pinned adapter distribution metadata. The default Codex adapter package version was taken from that reviewed registry. Codeg's application, database and user interface were not copied wholesale into Codev.

The running agent adapters are separate upstream programs and retain their respective licenses and authentication requirements. They are not included in Codev's source tree or installed during application startup.
