# NativePanelTransactionOptions Object

* `expectedRevision` number (optional) - Current revision required for the transaction.
* `revision` number (optional) - Strictly increasing safe integer content revision.

Stale revisions return false without changing state. Omitted successful content
updates increment the revision. Assign request revisions before starting asynchronous work.
