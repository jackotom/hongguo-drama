# Playback v5 synthetic fixtures and verification

SPDX-License-Identifier: GPL-3.0-only

Source: `N3urda/hongguoTV`, fixed GPL-3.0 commit
`18c37c2afd0567520135abcae312352542f09083`.

The two JSON files are unmodified public synthetic vectors fetched with `gh api`
from `kotlin-tv/core/src/test/resources/` at that commit. They contain no user
identity, captured session, authenticated media URL, or account credential.

| Fixture | Rows | SHA256 |
| --- | ---: | --- |
| signing-v5-f13.json | 32 | cc6863401ab7904b035940310612403b859e09703332c86450f7a20cd2a1c7bd |
| signing-v5-carrier.json | 4 | 850b53855444fa94b0bd3bcf6fa8a21254c585926080267b5ea2ffa177fe68a7 |

Related upstream files reviewed: `Signer.kt`, `AesV3.kt`, `V5Constants.kt`,
`MobilePlayback.kt`, `VendorConstants.kt` and `SignerV5Test.kt`, plus
`SIGNING_V5.md`. The JS port uses that GPL implementation and the existing
GPL `app-source.js` arithmetic/constants; it does not import `app-source.js`.
No PolyForm implementation, SDK, Java runtime, remote signer or new package
is used. Shared SM3 is imported from `src/native/sm3.js`.

## Entry point

`require('./playback-v5').signPlaybackV5({ base, values, body, now = Date.now() })`
returns only `{ url, headers }`. `base` must be HTTPS without credentials,
query, fragment or a nonstandard port. `values` is a plain record of strings,
including positive decimal `device_id` / `iid` and nonempty `cdid`,
`version_name`, `channel`, `os_version`, `device_type`. Optional `aid` must
equal `8662`. Identity is never synthesized or loaded from a static device.

The exact caller-owned gzip Buffer is signed and never recompressed or changed.
Both compressed and decompressed bodies are bounded to 2 MiB. Query records are
bounded to 128 fields, field names to 128 characters, values to 8192 characters,
and required profile strings to 128 characters. Invalid Unicode, control
characters, accessors, symbols and non-string fields are rejected.

Milliseconds must be a nonnegative safe integer within the upstream signed
32-bit seconds range (through 2038-01-19 03:14:07 UTC). `ts` is sampled from
the original `now`, never from an adjusted ticket. An existing `ts` query field
is updated consistently; none is added by default. `_rticket` is the first
candidate from `now + 0` through `now + 1023` whose IV low nibble is 12.
All other query fields preserve their order and values. The returned URL must
be sent as-is with the original body. Headers are exactly `x-khronos`,
`x-helios`, `x-medusa`, `x-ss-stub` and `x-ss-req-ticket`; the last binds the
selected final ticket. Transport headers remain the caller's responsibility.

## Recorded verification — 2026-11-16

Only this offline test was run:

```sh
rtk proxy node --test --test-reporter=spec src/native/playback-v5.test.cjs
```

Initial run: exit 0; tests 10, pass 10, fail 0, cancelled 0, skipped 0,
todo 0; reported duration 101.417042 ms. No implementation repair was needed.

The main controller then explicitly requested a cross-realm regression. The
existing prototype-chain check already supported cross-realm plain records;
only the test was extended. Latest run of the same command: exit 0; tests 11,
pass 11, fail 0, cancelled 0, skipped 0, todo 0; duration 103.656125 ms.
No other test suite was run.

Coverage:

- Independent upstream f13 vectors for all 32 timestamp rotation classes;
  20-byte output and v5 checksum bits; rejection of unsupported branches.
- Independent complete carrier ciphertext for all four permutations and input
  immutability.
- Real gzip Buffers and the final encoded query across 32 timestamps, including
  tickets crossing a second boundary; first matching ticket selection,
  exact stub, header allowlist, v5 prefix and unsigned random fields.
- Inspection of the actual serialized Medusa bytes before the envelope
  transform: registered device ID in both protobuf locations; current version,
  channel, OS and model in the nested environment; timestamp consistency.
- Query, gzip payload, gzip metadata, `iid` and `cdid` changes with all randomness
  fixed, proving changes are not hidden by random output.
- Independent inverse Helios transform verifies the timestamp, v5 license,
  aid and padding.
- Exactly 1024 branch misses terminate without additional time/random samples;
  ticket offset 1023 succeeds; default `now` is sampled once.
- Malformed URL, invalid identity, invalid query and non-gzip/corrupt body
  rejection, with errors excluding identity values.
- Explicit cross-realm options and values with a Node gzip Buffer are accepted;
  a synthetic non-UUID `cdid` is preserved and no `ts` query is added. Custom
  prototypes and class instances remain rejected. The other VM-based tests
  also pass ordinary records from the host realm into the module's realm.

The test VM exposes internals only inside its own context; production exports
only `signPlaybackV5`. Failure messages do not print signatures or identities.
No registration, upstream playback request, actual video playback, integration
test, platform build, installation or release was performed. Only public code
and synthetic fixtures were downloaded. Live acceptance and the parallel
`app-source.js` integration remain the main controller's responsibility.
