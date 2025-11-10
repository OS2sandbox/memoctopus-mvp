from pydantic import BaseModel, Field
from typing import Optional
from enum import Enum
from datetime import datetime


class PromptCategory(str, Enum):
    """Enum for prompt categories matching frontend constants."""
    BESLUTNINGSREFERAT = "Beslutningsreferat"
    API = "API"
    TODO_LISTE = "To do liste"
    DETALJERET_REFERAT = "Detaljeret referat"
    KORT_REFERAT = "Kort referat"


class Creator(BaseModel):
    """Creator information embedded in prompt."""
    id: str
    name: str


class PromptBase(BaseModel):
    """Base prompt model with common fields."""
    name: str
    category: PromptCategory
    is_favorite: bool = Field(default=False, alias="isFavorite")
    text: str

    class Config:
        populate_by_name = True  # Allow both snake_case and camelCase for input


class PromptCreate(PromptBase):
    """Model for creating a new prompt (no ID or creator, derived from auth)."""
    pass


class PromptUpdate(PromptBase):
    """Model for updating an existing prompt."""
    pass


class PromptResponse(PromptBase):
    """Model for prompt responses including all fields."""
    id: str
    creator: Creator
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")

    class Config:
        from_attributes = True
        populate_by_name = True
        by_alias = True  # Use aliases when serializing to JSON
