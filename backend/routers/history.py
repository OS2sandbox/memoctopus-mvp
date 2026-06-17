from fastapi import APIRouter, Depends, HTTPException
from typing import List
import json

from models import HistoryEntryCreate, HistoryEntryUpdate, HistoryEntryResponse, TranscriptAsset, PromptAsset
from auth import get_current_user, AuthenticatedUser
from database import get_database, Database

router = APIRouter(prefix="/api/history", tags=["history"])


@router.get("", response_model=List[HistoryEntryResponse], response_model_by_alias=True)
async def get_history_entries(
    current_user: AuthenticatedUser = Depends(get_current_user),
    db: Database = Depends(get_database)
):
    """
    Get all history entries for the authenticated user.

    Returns:
        List[HistoryEntryResponse]: List of history entries owned by the user
    """
    query = """
        SELECT
            he.id,
            he.user_id,
            he.title,
            he.created_at,
            COALESCE(
                json_agg(
                    json_build_object(
                        'kind', ha.asset_kind,
                        'data', ha.asset_data
                    )
                    ORDER BY ha.created_at
                ) FILTER (WHERE ha.id IS NOT NULL),
                '[]'::json
            ) as assets
        FROM history_entries he
        LEFT JOIN history_assets ha ON he.id = ha.history_entry_id
        WHERE he.user_id = :user_id
        GROUP BY he.id, he.user_id, he.title, he.created_at
        ORDER BY he.created_at DESC
    """

    rows = await db.fetch_all(query=query, values={"user_id": current_user.id})

    # Transform database rows to response models
    entries = []
    for row in rows:
        # Parse assets from JSON
        assets = []
        assets_data = row["assets"]

        if isinstance(assets_data, str):
            assets_data = json.loads(assets_data)

        for asset in assets_data:
            asset_kind = asset["kind"]
            asset_data = asset["data"]

            if asset_kind == "transcript":
                assets.append(TranscriptAsset(**asset_data))
            elif asset_kind == "prompt":
                assets.append(PromptAsset(**asset_data))

        entries.append(HistoryEntryResponse(
            id=str(row["id"]),
            user_id=row["user_id"],
            title=row["title"],
            assets=assets,
            created_at=row["created_at"]
        ))

    return entries

@router.patch(
    "/{entry_id}",
    response_model=HistoryEntryResponse,
    response_model_by_alias=True,
)
async def update_history_entry(
        entry_id: str,
        update: HistoryEntryUpdate,
        current_user: AuthenticatedUser = Depends(get_current_user),
        db: Database = Depends(get_database),
):
    """
    Partially update a history entry (title and\/or assets) for the current user.
    If `assets` is provided, existing assets are replaced.
    """
    # 1\) Ensure entry exists and belongs to user
    select_query = """
       SELECT
           he.id,
           he.user_id,
           he.title,
           he.created_at,
           COALESCE(
               json_agg(
               json_build_object(
                       'kind', ha.asset_kind,
                       'data', ha.asset_data
               )
               ORDER BY ha.created_at
                       ) FILTER (WHERE ha.id IS NOT NULL),
               '[]'::json
           ) as assets
       FROM history_entries he
                LEFT JOIN history_assets ha ON he.id = ha.history_entry_id
       WHERE he.id = :entry_id AND he.user_id = :user_id
       GROUP BY he.id, he.user_id, he.title, he.created_at \
       """
    row = await db.fetch_one(
        query=select_query,
        values={"entry_id": entry_id, "user_id": current_user.id},
    )

    if not row:
        raise HTTPException(status_code=404, detail="History entry not found")

    # 2\) Update title if provided
    new_title = row["title"]
    if update.title is not None:
        new_title = update.title.strip()
        title_query = """
                      UPDATE history_entries
                      SET title = :title
                      WHERE id = :entry_id AND user_id = :user_id \
                      """
        await db.execute(
            query=title_query,
            values={
                "title": new_title,
                "entry_id": entry_id,
                "user_id": current_user.id,
            },
        )

    # 3\) Replace assets if provided
    final_assets: List[TranscriptAsset | PromptAsset] = []

    if update.assets is not None:
        # Clear existing assets
        delete_assets_query = """
                              DELETE FROM history_assets
                              WHERE history_entry_id = :entry_id \
                              """
        await db.execute(
            query=delete_assets_query,
            values={"entry_id": entry_id},
        )

        # Insert new assets
        insert_asset_query = """
                             INSERT INTO history_assets (history_entry_id, asset_kind, asset_data)
                             VALUES (:history_entry_id, :asset_kind, :asset_data) \
                             """
        for asset in update.assets:
            await db.execute(
                query=insert_asset_query,
                values={
                    "history_entry_id": entry_id,
                    "asset_kind": asset.kind.value,
                    "asset_data": json.dumps(asset.model_dump(mode="json")),
                },
            )
        final_assets = update.assets
    else:
        # If assets not updated, parse existing ones from the row
        assets_data = row["assets"]
        if isinstance(assets_data, str):
            assets_data = json.loads(assets_data)

        for asset in assets_data:
            asset_kind = asset["kind"]
            asset_data = asset["data"]
            if asset_kind == "transcript":
                final_assets.append(TranscriptAsset(**asset_data))
            elif asset_kind == "prompt":
                final_assets.append(PromptAsset(**asset_data))

    # 4\) Return updated entry
    return HistoryEntryResponse(
        id=str(row["id"]),
        user_id=row["user_id"],
        title=new_title,
        assets=final_assets,
        created_at=row["created_at"],
    )

@router.get("/{entry_id}", response_model=HistoryEntryResponse, response_model_by_alias=True)
async def get_history_entry(
    entry_id: str,
    current_user: AuthenticatedUser = Depends(get_current_user),
    db: Database = Depends(get_database)
):
    """
    Get a single history entry by ID.

    Args:
        entry_id: UUID of the history entry

    Returns:
        HistoryEntryResponse: The history entry data

    Raises:
        HTTPException: 404 if entry not found or user doesn't have access
    """
    query = """
        SELECT
            he.id,
            he.user_id,
            he.title,
            he.created_at,
            COALESCE(
                json_agg(
                    json_build_object(
                        'kind', ha.asset_kind,
                        'data', ha.asset_data
                    )
                    ORDER BY ha.created_at
                ) FILTER (WHERE ha.id IS NOT NULL),
                '[]'::json
            ) as assets
        FROM history_entries he
        LEFT JOIN history_assets ha ON he.id = ha.history_entry_id
        WHERE he.id = :entry_id AND he.user_id = :user_id
        GROUP BY he.id, he.user_id, he.title, he.created_at
    """

    row = await db.fetch_one(
        query=query,
        values={"entry_id": entry_id, "user_id": current_user.id}
    )

    if not row:
        raise HTTPException(status_code=404, detail="History entry not found")

    # Parse assets from JSON
    assets = []
    assets_data = row["assets"]

    if isinstance(assets_data, str):
        assets_data = json.loads(assets_data)

    for asset in assets_data:
        asset_kind = asset["kind"]
        asset_data = asset["data"]

        if asset_kind == "transcript":
            assets.append(TranscriptAsset(**asset_data))
        elif asset_kind == "prompt":
            assets.append(PromptAsset(**asset_data))

    return HistoryEntryResponse(
        id=str(row["id"]),
        user_id=row["user_id"],
        title=row["title"],
        assets=assets,
        created_at=row["created_at"]
    )


@router.post("", response_model=HistoryEntryResponse, response_model_by_alias=True, status_code=201)
async def create_history_entry(
    entry: HistoryEntryCreate,
    current_user: AuthenticatedUser = Depends(get_current_user),
    db: Database = Depends(get_database)
):
    """
    Create a new history entry.

    Args:
        entry: HistoryEntryCreate data

    Returns:
        HistoryEntryResponse: The created history entry with ID

    Raises:
        HTTPException: 500 if creation fails
    """
    # Insert history entry
    entry_query = """
        INSERT INTO history_entries (
            user_id,
            title
        ) VALUES (
            :user_id,
            :title
        )
        RETURNING
            id,
            user_id,
            title,
            created_at
    """

    entry_row = await db.fetch_one(
        query=entry_query,
        values={
            "user_id": current_user.id,
            "title": entry.title
        }
    )

    if not entry_row:
        raise HTTPException(status_code=500, detail="Failed to create history entry")

    entry_id = entry_row["id"]

    # Insert assets
    asset_query = """
        INSERT INTO history_assets (
            history_entry_id,
            asset_kind,
            asset_data
        ) VALUES (
            :history_entry_id,
            :asset_kind,
            :asset_data
        )
    """

    for asset in entry.assets:
        asset_kind = asset.kind.value
        asset_data = asset.model_dump(mode='json')

        await db.execute(
            query=asset_query,
            values={
                "history_entry_id": entry_id,
                "asset_kind": asset_kind,
                "asset_data": json.dumps(asset_data)
            }
        )

    return HistoryEntryResponse(
        id=str(entry_id),
        user_id=current_user.id,
        title=entry.title,
        assets=entry.assets,
        created_at=entry_row["created_at"]
    )


@router.delete("/{entry_id}")
async def delete_history_entry(
    entry_id: str,
    current_user: AuthenticatedUser = Depends(get_current_user),
    db: Database = Depends(get_database)
):
    """
    Delete a history entry.

    Args:
        entry_id: UUID of the history entry to delete

    Returns:
        dict: Success message with deleted ID

    Raises:
        HTTPException: 404 if entry not found or user doesn't have access
    """
    query = """
        DELETE FROM history_entries
        WHERE id = :entry_id AND user_id = :user_id
        RETURNING id
    """

    row = await db.fetch_one(
        query=query,
        values={"entry_id": entry_id, "user_id": current_user.id}
    )

    if not row:
        raise HTTPException(status_code=404, detail="History entry not found")

    return {"id": str(row["id"])}
