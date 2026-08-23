import { z } from "zod";

// The public contract counts Unicode codepoints, not grapheme clusters.
// oxlint-disable-next-line typescript/no-misused-spread
const codepointLength = (value: string): number => [...value].length;

const titleSchema = z
  .string()
  .refine((title) => codepointLength(title) <= 100, {
    message: "title must contain at most 100 Unicode codepoints",
  });

export const planCheckTitleInputSchema = z
  .object({ title: titleSchema })
  .strict();

export const planCheckTitleOutputSchema = z
  .object({ ok: z.literal(true) })
  .strict();

export const planCheckTitleDescription =
  "Checks whether a collection title can be used without writing any collection data.";

export interface PlanCheckTitleDependencies {
  titleExists: (title: string) => Promise<boolean>;
}

export const checkPlanTitle = async (
  input: z.input<typeof planCheckTitleInputSchema>,
  dependencies: PlanCheckTitleDependencies
): Promise<z.output<typeof planCheckTitleOutputSchema>> => {
  const parsed = planCheckTitleInputSchema.parse(input);
  if (await dependencies.titleExists(parsed.title)) {
    throw new Error("collection title already exists");
  }

  return planCheckTitleOutputSchema.parse({ ok: true });
};
