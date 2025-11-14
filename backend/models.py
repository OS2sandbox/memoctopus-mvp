from pydantic import BaseModel, Field, field_validator
from typing import Optional, List
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

    @field_validator('name')
    @classmethod
    def validate_name(cls, v: str) -> str:
        """Validate prompt name length after trimming."""
        v = v.strip()
        if len(v) < 5:
            raise ValueError('Prompt name must be at least 5 characters')
        if len(v) > 200:
            raise ValueError('Prompt name must not exceed 200 characters')
        return v

    @field_validator('text')
    @classmethod
    def validate_text(cls, v: str) -> str:
        """Validate prompt text length after trimming."""
        v = v.strip()
        if len(v) < 5:
            raise ValueError('Prompt text must be at least 5 characters')
        if len(v) > 4000:
            raise ValueError('Prompt text must not exceed 4000 characters')
        return v


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


# History Entry Models

class AssetKind(str, Enum):
    """Enum for history entry asset types."""
    TRANSCRIPT = "transcript"
    PROMPT = "prompt"


class TranscriptAsset(BaseModel):
    """Transcript asset model."""
    kind: AssetKind = Field(default=AssetKind.TRANSCRIPT)
    text: str

    @field_validator('text')
    @classmethod
    def validate_text(cls, v: str) -> str:
        """Validate transcript text length after trimming."""
        v = v.strip()
        if len(v) < 5:
            raise ValueError('Transcript text must be at least 5 characters')
        if len(v) > 100000:
            raise ValueError('Transcript text must not exceed 100,000 characters')
        return v


class PromptAsset(BaseModel):
    """Prompt asset reference model."""
    kind: AssetKind = Field(default=AssetKind.PROMPT)
    promptId: str
    text: str

    @field_validator('text')
    @classmethod
    def validate_text(cls, v: str) -> str:
        """Validate prompt summary text length after trimming."""
        v = v.strip()
        if len(v) < 5:
            raise ValueError('Prompt summary text must be at least 5 characters')
        if len(v) > 50000:
            raise ValueError('Prompt summary text must not exceed 50,000 characters')
        return v


class HistoryEntryCreate(BaseModel):
    """Model for creating a history entry."""
    title: str
    assets: List[TranscriptAsset | PromptAsset]

    @field_validator('title')
    @classmethod
    def validate_title(cls, v: str) -> str:
        """Validate history entry title length after trimming."""
        v = v.strip()
        if len(v) < 5:
            raise ValueError('History entry title must be at least 5 characters')
        if len(v) > 200:
            raise ValueError('History entry title must not exceed 200 characters')
        return v

    @field_validator('assets')
    @classmethod
    def validate_assets(cls, v: List) -> List:
        """Validate that at least one asset is provided."""
        if len(v) < 1:
            raise ValueError('History entry must have at least one asset')
        return v


class HistoryEntryResponse(BaseModel):
    """Model for history entry responses."""
    id: str
    user_id: str = Field(alias="userId")
    title: str
    assets: List[TranscriptAsset | PromptAsset]
    created_at: datetime = Field(alias="createdAt")

    class Config:
        from_attributes = True
        populate_by_name = True
        by_alias = True


# Export Models

class ExportFormat(str, Enum):
    """Enum for export formats."""
    PDF = "pdf"
    DOCX = "docx"


class ExportRequest(BaseModel):
    """Model for export requests."""
    format: ExportFormat
    markdown: str

    @field_validator('markdown')
    @classmethod
    def validate_markdown(cls, v: str) -> str:
        """Validate markdown content is not empty."""
        v = v.strip()
        if len(v) < 1:
            raise ValueError('Markdown content cannot be empty')
        if len(v) > 500000:  # 500KB reasonable limit
            raise ValueError('Markdown content is too large (max 500,000 characters)')
        return v
