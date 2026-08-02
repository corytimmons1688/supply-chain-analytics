import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, ShieldAlert, Ban, CircleCheck } from "lucide-react";
import {
  useGetMe,
  useGetAppUsers,
  useSetAppUser,
  getGetAppUsersQueryKey,
  type AppUser,
} from "@workspace/api-client-react";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function AdminPage() {
  const { data: me, isPending: meLoading } = useGetMe();
  const isAdmin = me?.appRole === "admin";
  // Only ask for the user list once we know we're an admin — a member would just 403.
  const {
    data,
    isPending: usersLoading,
    error,
  } = useGetAppUsers({ query: { queryKey: getGetAppUsersQueryKey(), enabled: isAdmin } });
  const save = useSetAppUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const apply = (email: string, patch: { role?: string; status?: string }) => {
    save.mutate(
      { data: { email, ...patch } },
      {
        onSuccess: async () => {
          await queryClient.invalidateQueries({ queryKey: getGetAppUsersQueryKey() });
          toast({ title: "Saved", description: `${email} updated.` });
        },
        onError: (e) => {
          const msg =
            (e as { data?: { error?: string } })?.data?.error ?? (e instanceof Error ? e.message : "Save failed");
          toast({ title: "Not saved", description: msg, variant: "destructive" });
        },
      },
    );
  };

  if (meLoading) {
    return (
      <Layout>
        <Skeleton className="h-40 w-full" />
      </Layout>
    );
  }

  if (!isAdmin) {
    return (
      <Layout>
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-center">
            <ShieldAlert className="w-10 h-10 text-muted-foreground" />
            <p className="font-medium">Administrator access required</p>
            <p className="text-sm text-muted-foreground">
              Your account ({me?.email}) is a member. Ask an administrator to promote you if you need access to user
              management.
            </p>
          </CardContent>
        </Card>
      </Layout>
    );
  }

  const users = data?.users ?? [];

  return (
    <Layout>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center">
          <ShieldCheck className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Administration</h1>
          <p className="text-sm text-muted-foreground">
            Manage who can use this dashboard. Identity (sign-in, passwords, email verification) is handled by the
            shared auth service — this screen controls each account's access and role in this app only.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Users</CardTitle>
          <CardDescription>
            Anyone who registers and verifies their email can sign in; they appear here as a member after their first
            visit. Block an account to shut off its API and dashboard access immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {usersLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : error ? (
            <p className="text-sm text-destructive">Couldn't load users. Refresh to try again.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">First seen</TableHead>
                  <TableHead className="hidden md:table-cell">Last seen</TableHead>
                  <TableHead className="text-right">Access</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u: AppUser) => {
                  const self = u.email === me?.email?.toLowerCase();
                  const blocked = u.status === "blocked";
                  return (
                    <TableRow key={u.email} className={blocked ? "opacity-60" : undefined}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="min-w-0">
                            <div className="font-medium truncate">{u.name || u.email}</div>
                            {u.name ? <div className="text-xs text-muted-foreground truncate">{u.email}</div> : null}
                          </div>
                          {self ? <Badge variant="secondary">You</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Select
                          value={u.role}
                          onValueChange={(role) => apply(u.email, { role })}
                          disabled={self || save.isPending}
                        >
                          <SelectTrigger className="w-32 h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="member">Member</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        {blocked ? (
                          <Badge variant="destructive">Blocked</Badge>
                        ) : (
                          <Badge variant="outline" className="text-green-700 border-green-300 dark:text-green-400 dark:border-green-900">
                            Active
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">{fmtDate(u.firstSeenAt)}</TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">{fmtDate(u.lastSeenAt)}</TableCell>
                      <TableCell className="text-right">
                        {blocked ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={save.isPending}
                            onClick={() => apply(u.email, { status: "active" })}
                          >
                            <CircleCheck className="w-3.5 h-3.5 mr-1.5" />
                            Unblock
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-destructive hover:text-destructive"
                            disabled={self || save.isPending}
                            title={self ? "You can't block your own account" : undefined}
                            onClick={() => apply(u.email, { status: "blocked" })}
                          >
                            <Ban className="w-3.5 h-3.5 mr-1.5" />
                            Block
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {users.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground py-8">
                      No users yet.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}
