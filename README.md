# UPM Runtime Plugins

Patcher engines and shared JVM support for [Universal Patch Manager (UPM)](https://github.com/Jman-Github/Universal-Patch-Manager).

Runtime plugins are built and released independently of the manager. UPM discovers them through the [runtime catalog](catalog.json) and downloads compatible APKs from GitHub Releases.

## Available plugins

| Plugin | Module | Purpose |
| --- | --- | --- |
| ReVanced v21 | `revanced.v21-runtime-plugin` | Supports ReVanced v21 and legacy class-based patch bundles. |
| ReVanced v22 | `revanced.v22-runtime-plugin` | Supports ReVanced v22 patch bundles. |
| Morphe | `morphe-runtime` | Supports Morphe patch bundles (.mpp). |
| ReSeam | `reseam-runtime` | Supports ReSeam patch bundles (.reseam). |
| Shared support | `shared-support` | Provides shared components required by runtime plugins. |

## Using plugins

Select engines during UPM onboarding or from the runtime plugin screen. The shared support plugin is a required dependency: UPM downloads it automatically with the selected engines.

UPM stores downloaded plugin APKs privately. Installing them as separate Android apps is optional. Catalog-managed APKs must match the manager's signing identity and the release metadata, including package, protocol, version and checksum.

Engine plugins carry their own app icons. Release preparation generates catalog previews from those Android resources; UPM reads icons directly from downloaded APKs.

Manager data exports preserve runtime configuration, not the runtime APK files. Restoring a backup may require downloading the plugins again or importing local APKs.

## License and attribution

See [LICENSE](LICENSE), [source attribution](SOURCE.md), and [third-party notices](third-party/NOTICE.txt). Original copyright headers and upstream references are retained in the source.
