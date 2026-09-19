# Track exact source segments across chunk boundaries

Chunks may combine several Content Blocks or contain only part of one block, so block identifiers alone cannot support reliable provenance or bidirectional highlighting. Every Chunk will retain ordered Source Segments with block identity, page region, source text range, Chunk text range, and overlap status; human text correction changes the reviewed text without rewriting this source evidence.
