#!/usr/bin/env python3
"""One-time cleanup script: delete orphan cached_workflows whose provider no longer exists."""

from app.database import SessionLocal
from app.models import CachedWorkflow, Provider

def main():
    db = SessionLocal()
    try:
        # Find all provider IDs that exist
        provider_ids = {p.id for p in db.query(Provider.id).all()}

        # Find workflows whose provider_id is not in that set
        orphans = [
            wf for wf in db.query(CachedWorkflow).all()
            if wf.provider_id not in provider_ids
        ]

        print(f"Found {len(orphans)} orphan workflows:")
        for wf in orphans:
            print(f"  - {wf.id} (provider_id={wf.provider_id}, name={wf.name})")

        if orphans:
            for wf in orphans:
                db.delete(wf)
            db.commit()
            print(f"\nDeleted {len(orphans)} orphan workflows.")
        else:
            print("No orphans to clean up.")
    finally:
        db.close()

if __name__ == "__main__":
    main()
