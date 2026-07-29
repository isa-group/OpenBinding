"""the free plan is called FREE

The pricing document renamed the free plan from BASIC to FREE, and the pricing
is the source of truth: SPACE stores whichever plan name it was given, so a
gateway still saying BASIC would match no contract at all.

Data only. The enumerated columns are VARCHAR with no check constraint -
SQLAlchemy 2.0 leaves `create_constraint` off by default - so there is nothing
to alter, only rows to rewrite. `plan_cache` is a display cache rather than the
truth, but a stale value there fails to load as a `Plan` and takes the whole
user listing down with it.

Revision ID: 7ba4d278e76c
Revises: 0ab9390dc172
Create Date: 2026-07-29 20:42:02.790125+00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '7ba4d278e76c'
down_revision: Union[str, None] = '0ab9390dc172'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(sa.text("UPDATE users SET plan_cache = 'FREE' WHERE plan_cache = 'BASIC'"))


def downgrade() -> None:
    op.execute(sa.text("UPDATE users SET plan_cache = 'BASIC' WHERE plan_cache = 'FREE'"))
