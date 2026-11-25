# Transport fixtures

Only manually reviewed, synthetic or public minimal payloads are committed here.
The real probe stores raw responses under ignored `.statusgrid/probes/`; HTTP
success is G0 transport evidence and does not assert current service health.
`aws-cn-utf16be.hex` is the reviewed six-byte public response sampled on
2026-11-25T13:54:44.857Z; it decodes to `[]`, but that alone says nothing
about regional coverage or service status.
