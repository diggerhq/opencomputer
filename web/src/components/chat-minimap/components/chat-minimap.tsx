"use client";

import { cn } from "@/lib/utils";
import { createContext, use } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { isChatMinimapPayload } from "../lib/chat-minimap";
import type {
  ChatMinimapItemProps,
  ChatMinimapNavButtonProps,
  ChatMinimapPayload,
  ChatMinimapProps,
  ChatMinimapSide,
} from "../types/chat-minimap";

const HOVER_OPEN_DELAY_MS = 80;
const HOVER_CLOSE_DELAY_MS = 100;
const ITEM_FALLOFF_CLASS_NAME =
  "[&:is(:hover,:focus-visible)_svg]:w-6 [&:has(+[data-slot=chat-minimap-item]:is(:hover,:focus-visible))_svg]:w-5 [[data-slot=chat-minimap-item]:is(:hover,:focus-visible)+&_svg]:w-5 [&:has(+*+[data-slot=chat-minimap-item]:is(:hover,:focus-visible))_svg]:w-4 [[data-slot=chat-minimap-item]:is(:hover,:focus-visible)+*+&_svg]:w-4 focus-visible:text-foreground [&:has(+[data-slot=chat-minimap-item]:is(:hover,:focus-visible))]:text-foreground/75 [[data-slot=chat-minimap-item]:is(:hover,:focus-visible)+&]:text-foreground/75 [&:has(+*+[data-slot=chat-minimap-item]:is(:hover,:focus-visible))]:text-foreground/55 [[data-slot=chat-minimap-item]:is(:hover,:focus-visible)+*+&]:text-foreground/55";

const ChatMinimapContext = createContext<ChatMinimapSide>("right");

export const ChatMinimap = ({
  children,
  className,
  side = "right",
  ...props
}: ChatMinimapProps) => (
  <ChatMinimapContext value={side}>
    <HoverCard>
      {({ payload }) => (
        <>
          <nav
            aria-label="Conversation turns"
            className={cn(
              "group/chat-minimap flex w-fit flex-col",
              side === "left" ? "items-end" : "items-start",
              className
            )}
            data-side={side}
            data-slot="chat-minimap"
            {...props}
          >
            {children}
          </nav>
          <HoverCardContent
            align="center"
            className="w-64 bg-transparent p-0 shadow-none ring-0"
            side={side}
            sideOffset={8}
          >
            {isChatMinimapPayload(payload) ? (
              <Card
                className="bg-popover text-popover-foreground shadow-lg"
                data-slot="chat-minimap-card"
                size="sm"
              >
                <CardHeader className="gap-0.5">
                  <CardTitle className="truncate text-sm">
                    {payload.title}
                  </CardTitle>
                  {payload.description ? (
                    <CardDescription className="line-clamp-2 text-xs leading-relaxed">
                      {payload.description}
                    </CardDescription>
                  ) : null}
                </CardHeader>
              </Card>
            ) : null}
          </HoverCardContent>
        </>
      )}
    </HoverCard>
  </ChatMinimapContext>
);

export const ChatMinimapItem = ({
  active = false,
  className,
  description,
  title,
  ...props
}: ChatMinimapItemProps) => {
  const side = use(ChatMinimapContext);
  const payload: ChatMinimapPayload = { description, title };

  return (
    <HoverCardTrigger
      closeDelay={HOVER_CLOSE_DELAY_MS}
      delay={HOVER_OPEN_DELAY_MS}
      payload={payload}
      render={
        <Button
          className={cn(
            "text-muted-foreground/40 hover:text-foreground data-active:text-foreground data-popup-open:text-foreground h-2 w-8 rounded-none px-1 transition-colors hover:bg-transparent active:not-aria-[haspopup]:translate-y-0 dark:hover:bg-transparent",
            ITEM_FALLOFF_CLASS_NAME,
            side === "left" ? "justify-end" : "justify-start",
            className
          )}
          data-active={active || undefined}
          data-slot="chat-minimap-item"
          size="icon-xs"
          variant="ghost"
          {...props}
        />
      }
    >
      <svg
        aria-hidden="true"
        className={cn(
          "size-auto h-0.5 w-3 overflow-visible transition-[width] duration-200 ease-out motion-reduce:transition-none",
          side === "left" && "-scale-x-100"
        )}
        preserveAspectRatio="none"
        viewBox="0 0 24 2"
      >
        <rect fill="currentColor" height="2" width="24" />
      </svg>
      <span className="sr-only">{title}</span>
    </HoverCardTrigger>
  );
};

export const ChatMinimapNavButton = ({
  className,
  direction,
  label = direction === "previous" ? "Previous turn" : "Next turn",
  ...props
}: ChatMinimapNavButtonProps) => {
  const side = use(ChatMinimapContext);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={cn(
              "text-muted-foreground hover:text-foreground h-5 w-8 rounded-none px-1 opacity-0 transition-opacity duration-150 hover:bg-transparent hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none dark:hover:bg-transparent pointer-coarse:opacity-100",
              side === "left" ? "justify-end" : "justify-start",
              className
            )}
            data-direction={direction}
            data-slot="chat-minimap-nav-button"
            size="icon-xs"
            variant="ghost"
            {...props}
          />
        }
      >
        <svg
          aria-hidden="true"
          className={cn(
            "size-auto w-2.5",
            direction === "next" && "rotate-180"
          )}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          viewBox="0 0 10 6"
        >
          <path d="M.75 5.25 5 1l4.25 4.25" />
        </svg>
      </TooltipTrigger>
      <TooltipContent
        className="whitespace-nowrap"
        side={direction === "previous" ? "top" : "bottom"}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
};
