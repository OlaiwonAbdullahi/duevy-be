"""
Duevy agent taxonomy — the single source of truth for dataset generation.

Everything here is grounded in the REAL backend surface (src/ai/tools.ts) and the
REAL due categories (src/lib/dueTypes.ts). We never invent an intent the backend
can't perform. Changing a tool in the code means changing it here, then
regenerating the dataset — so the training data can't drift from reality.
"""

# --- Real due categories (must match src/lib/dueTypes.ts / Prisma DueType) ---
DUE_TYPES = [
    "handout", "departmental_due", "exam_levy", "lab_manual", "association_due",
    "departmental_wear", "trip_fee", "clearance", "other",
]

# --- Real tools (name → intent). Mirrors `tools` in src/ai/tools.ts. ---
# `mutating` tools carry a `confirmed` gate; training must teach confirm-first.
TOOLS = {
    "get_my_spaces":      {"mutating": False, "money": False},
    "set_active_space":   {"mutating": False, "money": False},
    "list_dues":          {"mutating": False, "money": False},
    "create_due":         {"mutating": True,  "money": True},
    "publish_due":        {"mutating": True,  "money": False},
    "close_due":          {"mutating": True,  "money": False},
    "delete_due":         {"mutating": True,  "money": False},
    "remind_unpaid":      {"mutating": True,  "money": False},
    "get_pay_link":       {"mutating": False, "money": False},
    "who_hasnt_paid":     {"mutating": False, "money": False},
    "collection_summary": {"mutating": False, "money": True},
    "space_overview":     {"mutating": False, "money": True},
    "payout_summary":     {"mutating": False, "money": True},
    "list_banks":         {"mutating": False, "money": False},
    "lookup_account":     {"mutating": False, "money": False},
    "list_beneficiaries": {"mutating": False, "money": False},
    "add_beneficiary":    {"mutating": True,  "money": False},
    "quote_withdrawal":   {"mutating": False, "money": True},
    "request_withdrawal": {"mutating": True,  "money": True},
    "list_payouts":       {"mutating": False, "money": True},
    "list_members":       {"mutating": False, "money": False},
    "list_reps":          {"mutating": False, "money": False},
    "add_corep":          {"mutating": True,  "money": False},
    "kyc_status":         {"mutating": False, "money": False},
    "update_space":       {"mutating": True,  "money": False},
}

# --- Nigerian / informal language maps (do NOT overfit — formal must work too) ---
# money slang → naira amount
MONEY_SLANG = {
    "2k": 2000, "5k": 5000, "10k": 10000, "1.5k": 1500, "500 naira": 500,
    "20k": 20000, "1m": 1000000, "2.5k": 2500, "₦2,000": 2000, "3k": 3000,
}
PLEASE = ["abeg", "please", "pls", "biko", "", "", ""]  # weighted toward none/please
QUICK = ["sharp sharp", "quickly", "now now", "asap", ""]
ALL_MEMBERS = ["everybody", "everyone", "all of them", "all members", "the whole class", "all the students"]
UNPAID_PHRASES = [
    "those wey never pay", "who never pay", "the ones that haven't paid",
    "people wey never pay", "defaulters", "who hasn't paid", "pending ones",
]

# departments / spaces students actually type
DEPARTMENTS = ["CSC", "EEE", "MEE", "Law", "Accounting", "Mass Comm", "Micro", "Physics", "Nursing", "Econs"]

# relative date expressions → the deterministic util resolves these (never the model)
DATE_EXPRESSIONS = [
    "today", "tomorrow", "next week", "same day next week", "a week from today",
    "in 3 days", "in two weeks", "next friday", "this friday", "by next saturday",
    "end of the month", "month end", "beginning of next month", "in 48 hours",
    "seven days from now", "by friday", "next monday", "end of the week",
]

# --- The 12 dataset categories from the brief (with target proportions) ---
CATEGORIES = {
    "nlu":                 0.10,  # formal/informal/typos/incomplete
    "intent":              0.12,  # intent classification → right tool
    "parameters":          0.12,  # entity/param extraction
    "datetime":            0.10,  # relative date expressions
    "multiturn":           0.10,  # context retention across turns
    "tool_calling":        0.12,  # correct tool + args + tool result → reply
    "financial_ops":       0.08,  # dues/collections/withdrawals end-to-end
    "nigerian_lang":       0.08,  # pidgin/slang heavy
    "error_handling":      0.06,  # tool errors, bad ids, KYC blocks
    "clarification":       0.05,  # ask only when necessary
    "security":            0.04,  # instruction hierarchy, org boundaries
    "out_of_scope":        0.03,  # refuse / redirect
}

SYSTEM_PROMPT = (
    "You are Duevy's assistant for a Nigerian student representative who collects "
    "dues for their department/association. Use the tools for every fact and action; "
    "never invent balances, counts, names or statuses. Amounts the rep types are in "
    "naira. Pass relative dates (e.g. 'next Friday', 'end of the month') straight to "
    "the tool — the backend resolves them to a real date; never ask for YYYY-MM-DD. "
    "Before creating a due, moving money, or anything destructive, call the tool "
    "without `confirmed` to get a summary, read it back, and only proceed with "
    "confirmed:true once the rep clearly agrees. Keep replies short and clear."
)
