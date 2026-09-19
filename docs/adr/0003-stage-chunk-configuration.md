# ADR 0003: Separate Configuration, Preview, and Revision

## Status

Accepted

## Context

Changing a chunking strategy or slider previously regenerated chunks immediately. This made parameter exploration destructive and could discard human revisions without an explicit decision; treating the first generated result as an editable draft also blurred parameter evaluation with human correction.

## Decision

The workbench keeps three explicit stages. Editing controls changes only the Configuration Draft. Applying it generates a replaceable Chunk Preview. Confirming the preview creates the Chunk Draft and enables human revision. Replacing an existing revised Chunk Draft requires explicit confirmation.

## Consequences

Controls never trigger generation by themselves. The preview always records the configuration that produced it, and the editable Chunk Draft always corresponds to a separately confirmed preview.
