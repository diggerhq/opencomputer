#!/usr/bin/env bash
# One-time Azure infrastructure for organizations' computers
# (work 052, "What a computer is, in Azure"), per region. Run by an Owner of the
# subscription (it creates role assignments and an app registration), with `az`
# logged in. Idempotent: re-running checks each piece and creates only what is
# missing. Per-organization resources (disk, NIC, VM) are the Worker's job.
#
#   REGION=eastus SUBSCRIPTION="<subscription name>" \
#     STORAGE_ACCOUNT=<account> STORAGE_RG=<its resource group> \
#     SECRET_FILE=~/.managed-agents-computers-secret bash scripts/computers-infra.sh
#
# STORAGE_ACCOUNT, STORAGE_RG: the storage account that holds the bootstrap
# bundle (container `bootstrap`). RG: the computers' resource group, default
# computers-$REGION.
# SECRET_FILE: where to write a new client secret for the Worker's service
# principal (mode 0600, never printed). Leave it unset to create no secret,
# e.g. on a re-run when the Worker already has one.
set -euo pipefail

REGION="${REGION:-eastus}"
SUBSCRIPTION="${SUBSCRIPTION:?set SUBSCRIPTION}"
SECRET_FILE="${SECRET_FILE:-}"
RG="${RG:-computers-$REGION}"
VNET=computers
SUBNET=computers
NSG=computers-nsg
NAT=computers-nat
NAT_IP=computers-nat-ip
IDENTITY=computer-bootstrap
SP_NAME=managed-agents-computers
DEPLOY_IDENTITY=calvin-deploy
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:?set STORAGE_ACCOUNT}"
STORAGE_RG="${STORAGE_RG:?set STORAGE_RG}"
CONTAINER=bootstrap

step() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
quietly() { "$@" >/dev/null 2>&1; }

# assign OBJECT_ID PRINCIPAL_TYPE ROLE SCOPE: a role assignment, unless it exists.
assign() {
  local object_id=$1 principal_type=$2 role=$3 scope=$4
  if [[ -n $(az role assignment list --assignee "$object_id" --role "$role" --scope "$scope" --query '[0].id' -o tsv) ]]; then
    note "already: $role on ${scope##*/}"
  else
    az role assignment create --assignee-object-id "$object_id" --assignee-principal-type "$principal_type" \
      --role "$role" --scope "$scope" -o none
    note "assigned: $role on ${scope##*/}"
  fi
}

step "subscription \"$SUBSCRIPTION\""
az account set --subscription "$SUBSCRIPTION"
SUB_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
RG_ID="/subscriptions/$SUB_ID/resourceGroups/$RG"

step "resource group $RG in $REGION"
az group create -n "$RG" -l "$REGION" --tags managed-by=managed-agents purpose=computers -o none

step "network security group $NSG (default rules: nothing inbound from outside the VNet)"
quietly az network nsg show -g "$RG" -n "$NSG" || az network nsg create -g "$RG" -n "$NSG" -l "$REGION" -o none

step "NAT gateway $NAT with static public IP $NAT_IP (all outbound traffic)"
quietly az network public-ip show -g "$RG" -n "$NAT_IP" ||
  az network public-ip create -g "$RG" -n "$NAT_IP" -l "$REGION" --sku Standard --allocation-method Static --version IPv4 -o none
quietly az network nat gateway show -g "$RG" -n "$NAT" ||
  az network nat gateway create -g "$RG" -n "$NAT" -l "$REGION" --public-ip-addresses "$NAT_IP" --idle-timeout 10 -o none

step "VNet $VNET 10.80.0.0/16, subnet $SUBNET 10.80.0.0/20 with the NSG and NAT gateway"
quietly az network vnet show -g "$RG" -n "$VNET" ||
  az network vnet create -g "$RG" -n "$VNET" -l "$REGION" --address-prefixes 10.80.0.0/16 -o none
quietly az network vnet subnet show -g "$RG" --vnet-name "$VNET" -n "$SUBNET" ||
  az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n "$SUBNET" --address-prefixes 10.80.0.0/20 \
    --network-security-group "$NSG" --nat-gateway "$NAT" -o none
# Also for a subnet made before: both must be attached.
az network vnet subnet update -g "$RG" --vnet-name "$VNET" -n "$SUBNET" --network-security-group "$NSG" --nat-gateway "$NAT" -o none
SUBNET_ID=$(az network vnet subnet show -g "$RG" --vnet-name "$VNET" -n "$SUBNET" --query id -o tsv)

step "managed identity $IDENTITY (computers read Calvin's release bundle with it)"
quietly az identity show -g "$RG" -n "$IDENTITY" || az identity create -g "$RG" -n "$IDENTITY" -l "$REGION" -o none
IDENTITY_ID=$(az identity show -g "$RG" -n "$IDENTITY" --query id -o tsv)
IDENTITY_CLIENT_ID=$(az identity show -g "$RG" -n "$IDENTITY" --query clientId -o tsv)
IDENTITY_PRINCIPAL_ID=$(az identity show -g "$RG" -n "$IDENTITY" --query principalId -o tsv)
STORAGE_ID=$(az storage account show -g "$STORAGE_RG" -n "$STORAGE_ACCOUNT" --query id -o tsv)
assign "$IDENTITY_PRINCIPAL_ID" ServicePrincipal "Storage Blob Data Reader" \
  "$STORAGE_ID/blobServices/default/containers/$CONTAINER"

step "service principal $SP_NAME (the platform Worker)"
APP_ID=$(az ad app list --display-name "$SP_NAME" --query '[0].appId' -o tsv)
if [[ -z $APP_ID ]]; then
  APP_ID=$(az ad app create --display-name "$SP_NAME" --query appId -o tsv)
  note "created app registration $APP_ID"
fi
SP_OBJECT_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv 2>/dev/null || true)
if [[ -z $SP_OBJECT_ID ]]; then
  SP_OBJECT_ID=$(az ad sp create --id "$APP_ID" --query id -o tsv)
  note "created service principal"
fi
assign "$SP_OBJECT_ID" ServicePrincipal Contributor "$RG_ID"
assign "$SP_OBJECT_ID" ServicePrincipal "Managed Identity Operator" "$IDENTITY_ID"
if [[ -n $SECRET_FILE ]]; then
  if [[ -e $SECRET_FILE ]]; then
    note "$SECRET_FILE exists; not creating another secret (delete it first to rotate)"
  else
    # Appended: secrets the Worker already uses stay valid until removed.
    (
      umask 077
      secret=$(az ad app credential reset --id "$APP_ID" --append --display-name "managed-agents platform" --years 1 --query password -o tsv)
      printf '%s' "$secret" >"$SECRET_FILE"
    )
    note "new client secret written to $SECRET_FILE (mode 0600; valid one year)"
  fi
else
  note "SECRET_FILE not set: no client secret created"
fi

step "Calvin's deploy identity $DEPLOY_IDENTITY: Virtual Machine Contributor on $RG (deploy/update.sh)"
DEPLOY_PRINCIPAL_ID=$(az identity list --query "[?name=='$DEPLOY_IDENTITY'] | [0].principalId" -o tsv)
if [[ -n $DEPLOY_PRINCIPAL_ID ]]; then
  assign "$DEPLOY_PRINCIPAL_ID" ServicePrincipal "Virtual Machine Contributor" "$RG_ID"
else
  echo "WARNING: no managed identity named $DEPLOY_IDENTITY in this subscription; Calvin's deploys will not reach computers in $RG" >&2
fi

cat <<EOF

Done. wrangler.platform.jsonc vars:

    "AZURE_SUBSCRIPTION_ID": "$SUB_ID",
    "AZURE_COMPUTER_RESOURCE_GROUP": "$RG",
    "AZURE_COMPUTER_REGION": "$REGION",
    "AZURE_COMPUTER_SUBNET_ID": "$SUBNET_ID",
    "AZURE_COMPUTER_IDENTITY_ID": "$IDENTITY_ID",
    "AZURE_COMPUTER_IDENTITY_CLIENT_ID": "$IDENTITY_CLIENT_ID",
    "COMPUTER_BOOTSTRAP_URL": "https://$STORAGE_ACCOUNT.blob.core.windows.net/$CONTAINER/calvin-latest.bundle",

Platform Worker secrets (from this directory):

    printf '%s' '$TENANT_ID' | npx wrangler secret put AZURE_TENANT_ID --config wrangler.platform.jsonc
    printf '%s' '$APP_ID' | npx wrangler secret put AZURE_CLIENT_ID --config wrangler.platform.jsonc
    npx wrangler secret put AZURE_CLIENT_SECRET --config wrangler.platform.jsonc < "${SECRET_FILE:-<the SECRET_FILE of the run that created it>}"
    openssl rand -base64 32 | tr -d '\\n' | npx wrangler secret put COMPUTER_HOST_TOKEN_KEY --config wrangler.production.jsonc

Then delete $([[ -n $SECRET_FILE ]] && printf '%s' "$SECRET_FILE" || printf 'the secret file'). Keep ~/.dash-computer-admin-token for
Calvin's deploy/update.sh must list $RG among its resource groups.
EOF
