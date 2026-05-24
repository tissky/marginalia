"""Pydantic schemas — request/response shapes used at API and service
boundaries.

These are intentionally separate from `db/models/` (SQLAlchemy ORM) so
that the persistence layer can change without rippling into the wire
contract, and so route handlers don't accidentally hand ORM rows back to
clients (which would couple the API to schema migrations).

Convention:
  - one module per domain, mirroring repositories/
  - use `model_config = ConfigDict(from_attributes=True)` when the schema
    will be built from an ORM row
"""
