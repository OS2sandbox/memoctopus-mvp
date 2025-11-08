"use client";

import { signOut, type User, useSession } from "@/lib/auth-client";
import { Avatar, AvatarFallback } from "@/lib/ui/core/shadcn/avatar";
import { Button } from "@/lib/ui/core/shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/lib/ui/core/shadcn/dropdown-menu";
import { getInitials } from "@/lib/utils/utils";

import { useRouter } from "next/navigation";

export function ProfileOverview() {
  const router = useRouter();

  const { data: session } = useSession();
  const user = session?.user as User | null;

  const initials = getInitials(user?.name);

  // TODO: Add avatarImage later
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Avatar>
          <AvatarFallback>{initials}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="w-64 p-4 rounded-lg shadow-md bg-white"
        sideOffset={8}
      >
        <div className="flex flex-col space-y-2 text-left">
          <p className="font-semibold text-sm">{user?.name}</p>
          <p className="text-sm text-muted-foreground leading-snug">
            Ortopædkirurgisk <br />
            Aalborg Universitetshospital
          </p>

          <Button
            variant="default"
            size="sm"
            className="mt-2"
            onClick={async () => {
              await signOut({
                fetchOptions: {
                  onSuccess: () => router.push("/sign-in"),
                },
              });
            }}
          >
            Log ud
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
