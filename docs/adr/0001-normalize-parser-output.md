# Normalize parser output before chunking

The platform will convert every parser-specific result into one backend-neutral Parsed Document before preview or chunking. Raw parser output remains available for diagnosis, while each Parsed Document retains source locations plus the parser backend and version; this prevents UI and chunking behavior from being coupled to incompatible or changing MinerU output schemas.
