<script lang="ts">
  import { getContext, type Snippet } from "svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";

  let {
    open = $bindable(false),
    title,
    description,
    triggerLabel,
    layout = "dialog",
    children,
    actions,
  }: {
    open?: boolean;
    title: string;
    description: string;
    triggerLabel: string;
    layout?: "dialog" | "sheet" | "drawer";
    children: Snippet;
    actions?: Snippet;
  } = $props();

  const getHost = getContext<() => HTMLElement | undefined>("rhythm-theme-host");
  if (!getHost) throw new Error("Modal requires ThemeScope");
</script>

<Dialog.Root bind:open>
  <Dialog.Trigger class="rhythm-action rhythm-action--secondary">
    {triggerLabel}
  </Dialog.Trigger>
  <Dialog.Content
    class={"rhythm-modal rhythm-modal--" + layout}
    portalProps={{ to: getHost() }}
    showCloseButton={false}
  >
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>{description}</Dialog.Description>
    </Dialog.Header>
    <div class="rhythm-modal-body">
      {@render children()}
    </div>
    <div class="rhythm-actions">
      <Dialog.Close class="rhythm-action rhythm-action--secondary">Закрыть</Dialog.Close>
      {#if actions}{@render actions()}{/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
