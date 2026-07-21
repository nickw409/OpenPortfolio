import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/accounts')({
  component: AccountsPage,
});

function AccountsPage(): JSX.Element {
  return <div className="p-6">Accounts placeholder</div>;
}
