from fastapi import APIRouter, Depends, HTTPException
from typing import List
from uuid import UUID

from models import PromptCreate, PromptUpdate, PromptResponse, Creator
from auth import get_current_user, AuthenticatedUser
from database import get_database, Database

router = APIRouter(prefix="/api/prompts", tags=["prompts"])


@router.get("", response_model=List[PromptResponse], response_model_by_alias=True)
async def get_prompts(
    current_user: AuthenticatedUser = Depends(get_current_user),
    db: Database = Depends(get_database)
):
    """
    Get all prompts for the authenticated user.

    Returns:
        List[PromptResponse]: List of prompts owned by the user with user-specific favorite status
    """
    query = """
        SELECT
            p.id,
            p.name,
            p.creator_id,
            p.creator_name,
            p.category,
            p.text,
            p.created_at,
            p.updated_at,
            CASE WHEN upf.user_id IS NOT NULL THEN true ELSE false END as is_favorite
        FROM prompts p
        LEFT JOIN user_prompt_favorites upf
            ON p.id = upf.prompt_id AND upf.user_id = :user_id
        WHERE p.creator_id = :user_id
        ORDER BY p.created_at DESC
    """

    rows = await db.fetch_all(query=query, values={"user_id": current_user.id})

    # Transform database rows to response models
    prompts = []
    for row in rows:
        prompts.append(PromptResponse(
            id=str(row["id"]),
            name=row["name"],
            creator=Creator(
                id=row["creator_id"],
                name=row["creator_name"]
            ),
            category=row["category"],
            is_favorite=row["is_favorite"],
            text=row["text"],
            created_at=row["created_at"],
            updated_at=row["updated_at"]
        ))

    return prompts


@router.get("/{prompt_id}", response_model=PromptResponse, response_model_by_alias=True)
async def get_prompt(
    prompt_id: str,
    current_user: AuthenticatedUser = Depends(get_current_user),
    db: Database = Depends(get_database)
):
    """
    Get a single prompt by ID.

    Args:
        prompt_id: UUID of the prompt

    Returns:
        PromptResponse: The prompt data with user-specific favorite status

    Raises:
        HTTPException: 404 if prompt not found or user doesn't have access
    """
    query = """
        SELECT
            p.id,
            p.name,
            p.creator_id,
            p.creator_name,
            p.category,
            p.text,
            p.created_at,
            p.updated_at,
            CASE WHEN upf.user_id IS NOT NULL THEN true ELSE false END as is_favorite
        FROM prompts p
        LEFT JOIN user_prompt_favorites upf
            ON p.id = upf.prompt_id AND upf.user_id = :user_id
        WHERE p.id = :prompt_id AND p.creator_id = :user_id
    """

    row = await db.fetch_one(
        query=query,
        values={"prompt_id": prompt_id, "user_id": current_user.id}
    )

    if not row:
        raise HTTPException(status_code=404, detail="Prompt not found")

    return PromptResponse(
        id=str(row["id"]),
        name=row["name"],
        creator=Creator(
            id=row["creator_id"],
            name=row["creator_name"]
        ),
        category=row["category"],
        is_favorite=row["is_favorite"],
        text=row["text"],
        created_at=row["created_at"],
        updated_at=row["updated_at"]
    )


@router.post("", response_model=PromptResponse, response_model_by_alias=True, status_code=201)
async def create_prompt(
    prompt: PromptCreate,
    current_user: AuthenticatedUser = Depends(get_current_user),
    db: Database = Depends(get_database)
):
    """
    Create a new prompt.

    Args:
        prompt: PromptCreate data

    Returns:
        PromptResponse: The created prompt with ID

    Raises:
        HTTPException: 500 if creation fails
    """
    # Insert prompt without is_favorite (now removed from prompts table)
    query = """
        INSERT INTO prompts (
            name,
            creator_id,
            creator_name,
            category,
            text
        ) VALUES (
            :name,
            :creator_id,
            :creator_name,
            :category,
            :text
        )
        RETURNING
            id,
            name,
            creator_id,
            creator_name,
            category,
            text,
            created_at,
            updated_at
    """

    values = {
        "name": prompt.name,
        "creator_id": current_user.id,
        "creator_name": current_user.name,
        "category": prompt.category.value,
        "text": prompt.text
    }

    row = await db.fetch_one(query=query, values=values)

    if not row:
        raise HTTPException(status_code=500, detail="Failed to create prompt")

    # If is_favorite is True, add to favorites table
    if prompt.is_favorite:
        favorite_query = """
            INSERT INTO user_prompt_favorites (user_id, prompt_id)
            VALUES (:user_id, :prompt_id)
            ON CONFLICT DO NOTHING
        """
        await db.execute(
            query=favorite_query,
            values={"user_id": current_user.id, "prompt_id": row["id"]}
        )

    return PromptResponse(
        id=str(row["id"]),
        name=row["name"],
        creator=Creator(
            id=row["creator_id"],
            name=row["creator_name"]
        ),
        category=row["category"],
        is_favorite=prompt.is_favorite,  # Return the value from request
        text=row["text"],
        created_at=row["created_at"],
        updated_at=row["updated_at"]
    )


@router.put("/{prompt_id}", response_model=PromptResponse, response_model_by_alias=True)
async def update_prompt(
    prompt_id: str,
    prompt: PromptUpdate,
    current_user: AuthenticatedUser = Depends(get_current_user),
    db: Database = Depends(get_database)
):
    """
    Update an existing prompt.

    Args:
        prompt_id: UUID of the prompt to update
        prompt: PromptUpdate data

    Returns:
        PromptResponse: The updated prompt

    Raises:
        HTTPException: 404 if prompt not found or user doesn't have access
    """
    # First check if prompt exists and user owns it
    check_query = """
        SELECT id FROM prompts
        WHERE id = :prompt_id AND creator_id = :user_id
    """

    exists = await db.fetch_one(
        query=check_query,
        values={"prompt_id": prompt_id, "user_id": current_user.id}
    )

    if not exists:
        raise HTTPException(status_code=404, detail="Prompt not found")

    # Update the prompt (without is_favorite)
    query = """
        UPDATE prompts
        SET
            name = :name,
            category = :category,
            text = :text,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = :prompt_id AND creator_id = :user_id
        RETURNING
            id,
            name,
            creator_id,
            creator_name,
            category,
            text,
            created_at,
            updated_at
    """

    values = {
        "prompt_id": prompt_id,
        "user_id": current_user.id,
        "name": prompt.name,
        "category": prompt.category.value,
        "text": prompt.text
    }

    row = await db.fetch_one(query=query, values=values)

    if not row:
        raise HTTPException(status_code=500, detail="Failed to update prompt")

    # Handle favorite status separately
    if prompt.is_favorite:
        # Add to favorites
        favorite_query = """
            INSERT INTO user_prompt_favorites (user_id, prompt_id)
            VALUES (:user_id, :prompt_id)
            ON CONFLICT DO NOTHING
        """
        await db.execute(
            query=favorite_query,
            values={"user_id": current_user.id, "prompt_id": prompt_id}
        )
    else:
        # Remove from favorites
        unfavorite_query = """
            DELETE FROM user_prompt_favorites
            WHERE user_id = :user_id AND prompt_id = :prompt_id
        """
        await db.execute(
            query=unfavorite_query,
            values={"user_id": current_user.id, "prompt_id": prompt_id}
        )

    return PromptResponse(
        id=str(row["id"]),
        name=row["name"],
        creator=Creator(
            id=row["creator_id"],
            name=row["creator_name"]
        ),
        category=row["category"],
        is_favorite=prompt.is_favorite,  # Return the value from request
        text=row["text"],
        created_at=row["created_at"],
        updated_at=row["updated_at"]
    )


@router.delete("/{prompt_id}")
async def delete_prompt(
    prompt_id: str,
    current_user: AuthenticatedUser = Depends(get_current_user),
    db: Database = Depends(get_database)
):
    """
    Delete a prompt.

    Args:
        prompt_id: UUID of the prompt to delete

    Returns:
        dict: Success message with deleted ID

    Raises:
        HTTPException: 404 if prompt not found or user doesn't have access
    """
    query = """
        DELETE FROM prompts
        WHERE id = :prompt_id AND creator_id = :user_id
        RETURNING id
    """

    row = await db.fetch_one(
        query=query,
        values={"prompt_id": prompt_id, "user_id": current_user.id}
    )

    if not row:
        raise HTTPException(status_code=404, detail="Prompt not found")

    return {"id": str(row["id"])}
