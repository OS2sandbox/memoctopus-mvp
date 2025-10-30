import { LucideHelpCircle } from "lucide-react";

import { Button } from "@/components/core/shadcn/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/core/shadcn/sheet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/core/shadcn/tabs";

export const PromptHelpPanel = () => {
  const textClassName = "text-sm text-muted-foreground ml-5 mt-5";

  return (
    <Sheet isModal={true}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="ml-2">
          <LucideHelpCircle />
        </Button>
      </SheetTrigger>

      <SheetContent
        onInteractOutside={(e) => e.preventDefault()}
        className="w-[400px] p-2"
        noOverlay={true}
      >
        <SheetHeader>
          <SheetTitle>Hjælp til prompt</SheetTitle>
        </SheetHeader>

        <Tabs defaultValue="meeting">
          <TabsList className="grid grid-cols-3 mb-4 mx-auto">
            <TabsTrigger value="meeting">Møder</TabsTrigger>
            <TabsTrigger value="systems">Systemer</TabsTrigger>
            <TabsTrigger value="api">API</TabsTrigger>
          </TabsList>

          <TabsContent value="meeting">
            <p className={textClassName}>Lorem Ipsum Dolor sit Amet</p>
          </TabsContent>
          <TabsContent value="systems">
            <p className={textClassName}>Lorem Ipsum Dolor sit Amet 2</p>
          </TabsContent>
          <TabsContent value="api">
            <p className={textClassName}>Lorem Ipsum Dolor sit Amet 3</p>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
};
