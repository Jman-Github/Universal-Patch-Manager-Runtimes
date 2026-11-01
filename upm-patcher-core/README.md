# Morphe JVM host

The `upm-patcher-core` module packages the Morphe engine as an isolated JVM host JAR. The Morphe plugin carries this JAR alongside its Android implementation.

The shared process entry point and event protocol live in `jvm-host`. ReVanced engines and the tool host are built by separate modules. No host requires a manager checkout or resources from a manager APK.

## Engine hosts

| Module | Host |
| --- | --- |
| `upm-patcher-core` | Morphe |
| `revanced21-patcher-core` | ReVanced v21 |
| `revanced-legacy-patcher-core` | Legacy ReVanced class-based bundles |
| `revanced22-patcher-core` | ReVanced v22 |
| `tools-patcher-core` | APK preparation and signature metadata tools |

The v21 plugin includes the legacy host. Reseam uses its native Android SDK in an ART worker rather than a JVM host.

## Execution and isolation

UPM launches JVM patching in disposable bound worker processes. Each run receives the selected engine host and its bundle class loader. Completing or cancelling a run ends the worker and releases its heap.

JVM startup failures can fall back to ART for compatible engines. Once patching has started, engine failures are reported without automatically repeating the operation. Reseam always uses ART.

Host entry points, callbacks and progress events form the interface with the manager. Changes to that interface require compatible manager adapters and protocol metadata.

## Shared JVM support

The required `shared-support` plugin supplies Android JVM images and the tool host. It carries OpenJDK 25 for ARM64 and x86-64, and OpenJDK 17 for 32-bit ARM. UPM selects an image for the manager process ABI.

Images use a shared Java module image with architecture-specific differences. UPM reconstructs the selected image in private storage before first use. Runtime preparation and compression tasks live in `buildSrc`; download hashes and image contents are configured in `shared-support/build.gradle.kts`.

## Packaging

Each engine plugin includes its own JVM host JAR under `assets/jvm/`. The shared support plugin carries `tools-patcher-core.jar`. Hosts retain their own framework resources.

Host JARs are shrunk while preserving engine entry points, bundle-facing APIs and required Kotlin metadata. Morphe uses Kotlin's standard reflection fallback; ReVanced hosts retain the reflection support required by their SDKs.

## Diagnostics

JVM hosts report VM details, memory use and patching progress through the event protocol. A stall watcher records thread stacks and heap usage when progress stops, without cancelling a run solely because it is slow.

The GC-overhead guard reports an out-of-memory failure when garbage collection consumes at least 60% of a two-minute window. Monitoring ends with the worker.

## Building and testing

Build from the repository root with JDK 17 and a JDK 25 toolchain available for the shared JVM images:

```sh
./gradlew assembleRelease
```

On Windows, use `.\gradlew.bat assembleRelease`. Android SDK and dependency requirements are described in the [repository README](../README.md).

Focused regression scripts under `tests/scripts/` cover host isolation, memory behavior, bundle loading and APK preparation. Some checks require previously built host JARs and cached compiler dependencies.

## Attribution and licenses


The runtime architecture and diagnostics adapt Morphe Manager
[PR #1202](https://github.com/MorpheApp/morphe-manager/pull/1202),
[PR #1212](https://github.com/MorpheApp/morphe-manager/pull/1212),
[PR #1215](https://github.com/MorpheApp/morphe-manager/pull/1215),
[PR #1223](https://github.com/MorpheApp/morphe-manager/pull/1223), and
[PR #1246](https://github.com/MorpheApp/morphe-manager/pull/1246), plus the
[heap-budget fix](https://github.com/MorpheApp/morphe-manager/commit/77af30c2e2711d6b745ffa435a5a7fa534277449)
and [GC-overhead guard](https://github.com/MorpheApp/morphe-manager/commit/76b5477eca7a97b393a95cc5880d90d1ab47354a).
Original copyright headers and source attribution are retained. The required
Morphe notice is available in [NOTICE.txt](../third-party/NOTICE.txt).

The Android OpenJDK builds come from
[AngelAuraMC](https://github.com/AngelAuraMC/angelauramc-openjdk-build).
Build recipes and source references are published in that repository.
OpenJDK is licensed under GPLv2 with the Classpath Exception. Each linked module's
legal notices are included in the runtime archive under `legal/`, and OpenJDK
retains its upstream license and notices.
