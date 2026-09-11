export function canConfirmProjectDeletion(
  confirmation: string,
  projectName: string,
) {
  return confirmation === projectName
}
