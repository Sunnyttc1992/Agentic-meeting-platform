# Start with a modular monolith

The first production slice is a Node modular monolith with explicit repository, audit, and clock seams. This keeps policy and transactional behavior local while the domain is still changing; durable storage, identity, search, and model providers can replace in-memory adapters independently without paying the operational and consistency cost of premature microservices.
