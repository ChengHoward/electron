# NativePanelNodePatch Object

* `op` string - `set`, `insert`, `remove`, or `replace`.
* `id` string - Target ID; insert targets the parent container.
* `properties` Record\<string, any\> (optional) - Required for set; cannot change identity or children.
  A supplied style replaces the complete node style.
* `index` number (optional) - Required integer insertion index.
* `node` [NativePanelContent](native-panel-content.md) (optional) - Inserted or replacement subtree.

Operations run in order on a candidate tree. Full validation precedes native mutations.
Removing the root is rejected. At most 2000 operations are accepted.
