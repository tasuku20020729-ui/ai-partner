export type Visibility = 'private' | 'shared';
export type Currency = 'JPY' | 'MYR' | 'USD';
export type ExpenseCategory = 'food' | 'daily_goods' | 'dating' | 'transport' | 'travel' | 'medical' | 'entertainment' | 'other';
export type TodoPriority = 'low' | 'middle' | 'high';
export type TodoStatus = 'open' | 'done';
export type Repeat = 'yearly' | 'none';
export type SpaceType = 'personal' | 'pair' | 'group';
export type SpaceRole = 'owner' | 'admin' | 'member';
export type InviteStatus = 'active' | 'revoked';

export type BaseDoc = {
  id: string;
  userId: string;
  ownerName: string;
  /** Legacy shared scope. During migration this is treated as spaceId. */
  groupId: string;
  /** New shared scope id. Optional until the groupId -> spaceId migration is complete. */
  spaceId?: string;
  spaceName?: string;
  visibility: Visibility;
  aiReadable: boolean;
  createdAt: string;
  updatedAt?: string;
};

export type Space = {
  id: string;
  name: string;
  type: SpaceType;
  ownerId: string;
  createdAt: string;
  updatedAt?: string;
  archivedAt?: string;
};

export type SpaceMember = {
  id: string;
  spaceId: string;
  userId: string;
  displayName: string;
  role: SpaceRole;
  relationshipLabels: string[];
  aliases: string[];
  joinedAt: string;
  updatedAt?: string;
};

export type Invite = {
  id: string;
  code: string;
  spaceId: string;
  createdBy: string;
  expiresAt?: string;
  maxUses?: number;
  usedCount: number;
  status: InviteStatus;
  createdAt: string;
  updatedAt?: string;
};

export type Diary = BaseDoc & {
  date: string;
  title: string;
  content: string;
  mood?: string;
  tags: string[];
  photos?: string[];
};

export type EventItem = BaseDoc & {
  title: string;
  description?: string;
  startAt: string;
  endAt?: string;
  location?: string;
  remindAt?: string;
  reminderEnabled?: boolean;
};

export type Todo = BaseDoc & {
  title: string;
  description?: string;
  dueAt?: string;
  priority: TodoPriority;
  status: TodoStatus;
  remindAt?: string;
  reminderEnabled?: boolean;
};

export type Expense = BaseDoc & {
  inputType: 'manual' | 'receipt' | 'ai_text';
  date: string;
  title: string;
  shopName?: string;
  amount: number;
  currency: Currency;
  amountBase: number;
  baseCurrency: Currency;
  exchangeRate: number;
  category: ExpenseCategory;
  paymentMethod?: string;
  memo?: string;
  receiptImageUrl?: string;
  receiptItems?: string[];
};

export type Anniversary = BaseDoc & {
  title: string;
  date: string;
  repeat: Repeat;
  remindDaysBefore?: number;
};

export type SharedNote = {
  id: string;
  /** Legacy shared scope. During migration this is treated as spaceId. */
  groupId: string;
  spaceId?: string;
  spaceName?: string;
  title: string;
  content: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt?: string;
};
