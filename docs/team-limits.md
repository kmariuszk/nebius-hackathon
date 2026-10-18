<!-- Source: https://github.com/dariolaportanebius/nebius-starter-skill/blob/hackathon-participant-guide/README.md#4-know-your-teams-limits -->

## 4. Know your team's limits

These limits apply to your team's project and are shared by all team members and workloads. The Standard bucket's 200 GiB size is a setting you apply when creating the bucket. Before launching a workload, check current project usage and reservation allowances; the table does not show remaining capacity.

| Resource | Team limit |
| --- | --- |
| Reserved GPU | **1 NVIDIA RTX PRO 6000 Blackwell Server Edition** |
| GPU platform / preset | `gpu-rtx6000-a` / `1gpu-24vcpu-218gb` |
| VM count | **3 total**, including VMs managed by Serverless workloads |
| CPU capacity for non-GPU VMs | **20 vCPUs total**; this is separate from the vCPUs in the GPU preset |
| Disks | **4 total** |
| Network SSD disk capacity | **500 GiB total**, including workload container and boot disks |
| Public IPv4 addresses | **1** |
| Container registries | **1 registry**; this is not a one-image limit |
| Object Storage buckets | **1** |
| Object Storage bucket size | Set **200 GiB** when creating your Standard bucket; separate from the 500 GiB disk allowance |

### Plan around one GPU

A GPU endpoint and a GPU DevLab are separate workloads and each requests a GPU. They cannot run simultaneously within this project's one-GPU allowance.

If you want to develop while a GPU endpoint is running, choose a **CPU-only DevLab or CPU VM**. Your CPU-only workloads share a **20-vCPU total**, and all workloads together must stay within the **three-VM total**, including the GPU endpoint's VM. Select the CPU option explicitly: a default template or CLI configuration may otherwise request a GPU. The exact CPU preset and template should be checked for availability before creation.

Stopping one GPU workload and starting another lets you reuse the allowance. Wait for capacity to be released before starting the replacement. Ask your teammates what is running before creating a new workload.

The 500 GiB disk allowance is also shared: two 250 GiB disks consume the whole allowance. A stopped DevLab retains its disk. Keep room for the other workload and save important outputs outside temporary container storage.
