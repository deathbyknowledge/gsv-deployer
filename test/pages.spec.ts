import { describe, expect, it } from "vitest";

import { getDeployHelp } from "../src/deploy-help";
import { confirmDeletePage, deployPage, homePage, managePage } from "../src/pages";

describe("free deployment copy", () => {
  it("explains the billing scope and paid-only CodeMode capability", () => {
    const deploy = deployPage(
      [{ id: "account-id", name: "Account" }],
      "account-settings.read billing.read workers-scripts.write",
      [],
      [],
    );

    expect(deploy).toContain("Check whether the account uses Workers Free or Paid");
    const home = homePage("https://github.com/example/gsv");
    expect(home).toContain("Workers Free is supported");
    expect(home).toContain("Workers Paid adds CodeMode and more CPU");
    expect(home).not.toContain("packages");
  });

  it("does not tell free-account users to upgrade when storage setup fails", () => {
    const storageHelp = getDeployHelp("Create R2 bucket failed");
    expect(storageHelp.whatToDo).toContain("Confirm R2 is enabled");
    expect(storageHelp.whatToDo).not.toContain("Workers Paid");
  });

  it("describes assembler as release-driven legacy compatibility", () => {
    const dependencyHelp = getDeployHelp("The selected gateway release requires the legacy assembler Worker.");
    expect(dependencyHelp.detail).toContain("legacy assembly Worker");
    expect(dependencyHelp.whatToDo).toContain("Legacy releases");
  });

  it("directs unsupported historical releases to latest stable", () => {
    const help = getDeployHelp(
      "Unsupported GSV release: the release does not include the complete stack (missing.tar.gz). Choose Latest stable and try again.",
    );

    expect(help.category).toBe("unsupported-release");
    expect(help.detail).toContain("older GSV release");
    expect(help.whatToDo).toContain("Latest stable");
  });

  it("keeps internal Worker components out of deployment choices", () => {
    const create = deployPage(
      [{ id: "account-id", name: "Account" }],
      "workers-scripts.write",
      [],
      [],
    );
    const update = deployPage(
      [{ id: "account-id", name: "Account" }],
      "workers-scripts.write",
      [],
      [],
      {
        mode: "update",
        accountId: "account-id",
        instance: "gsv",
      },
    );

    expect(create).toContain("installer handles the complete stack");
    expect(create).not.toContain('name="component"');
    expect(create).not.toContain("Discord bot token");
    expect(update).toContain("complete GSV installation");
    expect(update).not.toContain('name="component"');

    const invalidStackHelp = getDeployHelp("No components selected.");
    expect(invalidStackHelp.whatToDo).not.toMatch(/select .*component/i);
  });

  it("preserves a retry release that is no longer in the release list", () => {
    const retry = deployPage(
      [{ id: "account-id", name: "Account" }],
      "workers-scripts.write",
      [
        { value: "latest", label: "Latest stable", description: "Recommended." },
        { value: "dev", label: "Dev channel", description: "Prerelease." },
      ],
      [],
      {
        mode: "retry",
        accountId: "account-id",
        instance: "gsv",
        version: "v0.4.1",
      },
    );

    expect(retry).toContain('<option value="v0.4.1" selected>v0.4.1 (previous selection)</option>');
    expect(retry).not.toContain('<option value="latest" selected>');
  });

  it("requires an explicit account choice when the retry account is no longer authorized", () => {
    const retry = deployPage(
      [{ id: "another-account", name: "Another account" }],
      "workers-scripts.write",
      [],
      [],
      {
        mode: "retry",
        accountId: "original-account",
        instance: "gsv",
        version: "latest",
      },
    );

    expect(retry).toContain('<option value="" selected disabled>Choose an account for this retry</option>');
    expect(retry).not.toContain('<option value="another-account" selected>');
    expect(retry).toContain("original-account");
    expect(retry).toContain("is not currently authorized");
  });

  it("presents installations as managed cards and separates new deployment", () => {
    const overview = managePage([
      {
        accountId: "account-id",
        accountName: "Account",
        instance: "gsv",
        components: ["ripgit", "gateway"],
        scriptNames: ["ripgit", "gsv"],
        deleteSupported: true,
      },
    ]);

    expect(overview).toContain("Manage your existing GSVs");
    expect(overview).toContain('class="manage-card"');
    expect(overview).toContain("Managed install");
    expect(overview).toContain("Want to deploy a new one?");
    expect(overview).not.toContain("component-badges");
    expect(overview).not.toContain("<li class=\"manage-card\"");
  });

  it("makes full data deletion explicit before showing technical IDs", () => {
    const confirmation = confirmDeletePage({
      accountId: "account-id",
      accountName: "Account",
      instance: "gsv",
      components: ["ripgit", "gateway"],
      scriptNames: ["ripgit", "gsv"],
      deleteSupported: true,
    });

    expect(confirmation).toContain("GSV services and runtime data");
    expect(confirmation).toContain("Durable Object data");
    expect(confirmation).toContain("All files and storage");
    expect(confirmation).toContain("This cannot be undone");
    expect(confirmation).toContain("Technical details");
    expect(confirmation.indexOf("Technical details")).toBeLessThan(confirmation.indexOf("ripgit"));
    expect(confirmation).not.toContain('name="deleteStorage"');
    expect(confirmation).not.toContain("Will be kept");
  });

  it("keeps name-matched installations unverified when management tags are absent", () => {
    const overview = managePage([
      {
        accountId: "account-id",
        accountName: "Account",
        instance: "gsv",
        components: ["ripgit", "gateway"],
        scriptNames: ["ripgit", "gsv"],
        deleteSupported: false,
      },
    ]);

    expect(overview).toContain("Unverified install");
    expect(overview).toContain("legacy GSV installation or a name collision");
    expect(overview).not.toContain("/manage/delete?");
  });
});
