# Separate multimodal assets from vector records

Images remain source assets addressed by stable references; an Image Chunk combines that reference with provenance and optional model-generated text. A later vector index may store image or summary embeddings plus the asset reference, but it will not become the system of record for the image itself, keeping source preservation independent from model and index replacement.
