# Chunk Preview response example

The V2 preview endpoint returns exact source provenance and metrics from the same calculation. This deterministic example uses two short adjacent blocks on different pages; no uploaded document or credential is included.

```json
{
  "chunks": [
    {
      "id": "flow-1-1",
      "type": "text",
      "automaticText": "A1 商品安装前请断电。\n\n确认额定电压后连接电源。",
      "finalText": "A1 商品安装前请断电。\n\n确认额定电压后连接电源。",
      "sourceSegments": [
        {
          "blockId": "b1",
          "page": 1,
          "bbox": [10, 10, 100, 30],
          "sourceStart": 0,
          "sourceEnd": 12,
          "chunkStart": 0,
          "chunkEnd": 12,
          "isOverlap": false
        },
        {
          "blockId": "b2",
          "page": 2,
          "bbox": [10, 10, 100, 30],
          "sourceStart": 0,
          "sourceEnd": 12,
          "chunkStart": 14,
          "chunkEnd": 26,
          "isOverlap": false
        }
      ],
      "tokenCount": 21,
      "qualityFlags": ["undersized"],
      "productIdentity": "A1"
    }
  ],
  "metrics": {
    "chunkCount": 1,
    "token": { "minimum": 21, "average": 21, "maximum": 21 },
    "tokenDistribution": {
      "under80": 1,
      "80to255": 0,
      "256to511": 0,
      "512to1023": 0,
      "1024plus": 0
    },
    "oversizedCount": 0,
    "undersizedCount": 1,
    "actualOverlapRatio": 0,
    "crossPageCount": 1,
    "typeCounts": { "text": 1, "image": 0, "table": 0 },
    "missingProductIdentityCount": 0,
    "contextCandidateCount": 0
  }
}
```
