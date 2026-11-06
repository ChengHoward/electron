# NativePanelCapabilities Object

* `supported` boolean - Runtime support.
* `apiVersion` number - Contract version, `2` in this release.
* `backend` string - `views`.
* `createsWebContents` boolean - Always false.
* `features` string[] - Feature identifiers; empty on unsupported platforms.
* `limits` Object - Description limits.
  * `mountedNodes` number - Ordinary tree limit, 2000.
  * `dataNodes` number - Total data node limit, 100000.
  * `virtualRows` number - Rows per virtual list, 50000.
  * `depth` number - Maximum depth, 32.
