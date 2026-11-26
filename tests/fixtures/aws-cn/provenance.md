# AWS China unscoped catalog examples

`services-unscoped.json` contains two verbatim objects from the official
services catalog captured by the production probe at
`2026-11-26T08:15:12.714Z`:

```text
https://servicedata-cn-north-1-prod.s3.cn-north-1.amazonaws.com.cn/services.json
HTTP 200, application/json, UTF-8
56,815 decoded bytes
sha256:c7d2595bc542d155aa4d9c2eb41b7fd43f7ec3d4a625e7e01e1d4808d79b4f4e
```

Local source evidence:
`.statusgrid/task7-aws-investigation/2026-11-26T08-15-12-714Z/aws-cn/metadata.json`
and `responses/services.body`.

The 253 source entries contain 121 explicit `cn-north-1`, 118 explicit
`cn-northwest-1`, and 14 entries with `region_id` absent and `region_name:null`.
The two examples retain that absence. They establish unspecified geography,
not a synthetic global region. No explicit null/empty/nonstring `region_id`
was observed; supplied malformed values remain invalid.
