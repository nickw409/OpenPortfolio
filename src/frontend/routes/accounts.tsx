import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import { RouteErrorBoundary } from '@frontend/components/error-boundary';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@frontend/components/ui/table';
import { Skeleton } from '@frontend/components/ui/skeleton';
import { apiGet } from '@frontend/lib/api';
import { formatDate } from '@frontend/lib/format';

import type { AccountsResponse } from '@shared/schemas/account';
import { AccountsResponseSchema } from '@shared/schemas/account';

export const Route = createFileRoute('/accounts')({
  component: AccountsPage,
  errorComponent: RouteErrorBoundary,
});

async function fetchAccounts(signal: AbortSignal): Promise<AccountsResponse> {
  const raw = await apiGet<unknown>('/api/v1/accounts', signal);
  return AccountsResponseSchema.parse(raw);
}

function AccountsPage(): JSX.Element {
  const { data, isPending, error } = useQuery({
    queryKey: ['accounts'],
    queryFn: ({ signal }) => fetchAccounts(signal),
  });

  if (error) throw error;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold">Accounts</h1>
      <div className="mt-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Broker</TableHead>
              <TableHead>Tax treatment</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead>Cost-basis method</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending
              ? Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    {Array.from({ length: 6 }).map((__, j) => (
                      <TableCell key={`s-${i}-${j}`}>
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : data!.accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>{a.name}</TableCell>
                    <TableCell>{a.broker ?? '—'}</TableCell>
                    <TableCell>{a.taxTreatment}</TableCell>
                    <TableCell>{a.currencyCode}</TableCell>
                    <TableCell>{a.costBasisMethod}</TableCell>
                    <TableCell>{formatDate(a.createdAt)}</TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
