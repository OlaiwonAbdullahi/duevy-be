-- Guest form builder: the extra questions a rep asks on a due's guest pay
-- link (null = the original name/email/matric form), and each guest's answers,
-- kept on their checkout with the field labels copied in.
ALTER TABLE "dues" ADD COLUMN "guestFields" JSONB;
ALTER TABLE "checkouts" ADD COLUMN "guestAnswers" JSONB;
