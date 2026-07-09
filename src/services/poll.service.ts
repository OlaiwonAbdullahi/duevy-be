import { type Prisma } from '@prisma/client';

export type VoteSelection = {
  categoryId: string;
  nomineeId: string;
  quantity: number;
};

/**
 * Apply a batch of vote selections inside a transaction: record each PollVote,
 * bump the nominee tallies, and roll up the poll's totalVotes / revenue.
 * Shared by the synchronous wallet path and the webhook fulfilment path so the
 * counting logic lives in exactly one place.
 */
export async function applyPollVotes(
  tx: Prisma.TransactionClient,
  args: { pollId: string; userId: string; selections: VoteSelection[]; amountPerVote: number; reference?: string },
): Promise<{ totalQuantity: number; spaceRevenue: number }> {
  let totalQuantity = 0;

  for (const sel of args.selections) {
    totalQuantity += sel.quantity;
    await tx.pollVote.create({
      data: {
        userId: args.userId,
        nomineeId: sel.nomineeId,
        categoryId: sel.categoryId,
        quantity: sel.quantity,
        amountPaid: sel.quantity * args.amountPerVote, // face value credited to the space
        txnRef: args.reference,
      },
    });
    await tx.nominee.update({ where: { id: sel.nomineeId }, data: { votes: { increment: sel.quantity } } });
  }

  // The space keeps the full face (amountPerVote × votes); the 3% charge the
  // voter pays on top is handled by the caller and never enters poll.revenue.
  const spaceRevenue = totalQuantity * args.amountPerVote;
  await tx.poll.update({
    where: { id: args.pollId },
    data: { totalVotes: { increment: totalQuantity }, revenue: { increment: spaceRevenue } },
  });

  return { totalQuantity, spaceRevenue };
}
