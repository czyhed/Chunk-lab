# Name the custom semantic strategy accurately

The installed LlamaIndex JavaScript version does not provide the previously named `SemanticSplitterNodeParser`. The platform will retain the existing sentence-window embedding-distance algorithm, expose it as the `Semantic Boundary` Chunking Strategy, and record its embedding model; a second runtime is not introduced solely to obtain a differently named splitter.
