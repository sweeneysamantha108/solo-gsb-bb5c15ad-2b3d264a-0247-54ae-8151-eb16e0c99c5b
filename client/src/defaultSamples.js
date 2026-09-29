// Preloaded samples so the inference rules are visible on first load:
// optional fields, null unions, integer->number widening, heterogeneous arrays.
export const DEFAULT_SAMPLES = [
  `{
  "id": 1,
  "name": "Alice",
  "email": "alice@example.com",
  "age": 30,
  "tags": ["admin", "owner"],
  "address": { "city": "Shanghai", "zip": "200000" },
  "phone": null
}`,
  `{
  "id": 2,
  "name": "Bob",
  "age": 25.5,
  "tags": ["user", 42, null],
  "address": { "city": "Beijing" },
  "phone": "+86-13800000000",
  "active": true
}`,
];

export const DEFAULT_VALIDATE_SAMPLE = `{
  "id": "not-a-number",
  "name": "Carol",
  "tags": ["user", "vip"],
  "address": { "city": "Hangzhou" }
}`;
