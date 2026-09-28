# Use a short-lived document processing lease separate from persisted review state

**Status: accepted**

Chunk Lab will use the original file-byte SHA-256 as the document identity and a Redis-backed, TTL-based Document Processing Lease for exclusive editing. Drafts, revisions, and Review Progress remain durable server-side state; a later session acquires a new lease and resumes that state instead of inheriting the previous lease. This separation supports multi-day review, browser crashes, and handoff between authorized users without allowing concurrent writes.

The first version will use a single Redis instance with atomic `SET NX EX`, lease-ID-checked renewal, and Lua-checked release. It will not introduce Redlock, business batches, forced takeover, or Redis as the source of truth for review data. Export is a separate downstream snapshot and is allowed only when every Chunk is marked `completed`.
