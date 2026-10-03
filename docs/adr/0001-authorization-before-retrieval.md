# Authorize before retrieval

All meeting content and derived knowledge are selected only after a centralized policy decision has authorized an authenticated tenant-scoped Principal for the source Meeting. Search, AI, and agent workflows receive already-authorized records rather than retrieving broadly and filtering output, because post-retrieval filtering can leak protected content into prompts, caches, telemetry, and tool traces.
