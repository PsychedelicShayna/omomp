/** Turn a whole disk into a bootable, encrypted portable OMOMP system. */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { flashHelp as commandHelp } from "../cli/command-help";
import { runFlashCommand } from "../cli/flash-cli";

export default class Flash extends Command {
	static description = commandHelp.description;
	static args = {
		device: Args.string({
			description: "Whole-disk block device to flash (for example /dev/sdc); all data is destroyed",
			required: true,
		}),
	};

	static flags = {
		resume: Flags.boolean({
			description: "Resume an incomplete OMOMP flash without repartitioning or formatting",
			default: false,
		}),
		force: Flags.boolean({
			description: "Allow a non-removable disk or deliberately replace an existing OMOMP stick",
			default: false,
		}),
		user: Flags.string({
			description: "Payload owner whose portable profile is carried (defaults to $SUDO_USER)",
		}),
	};

	static examples = [
		"# Flash a removable disk\n  sudo omomp flash /dev/sdc",
		"# Resume an interrupted flash\n  sudo omomp flash --resume /dev/sdc",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Flash);
		process.exitCode = await runFlashCommand({
			device: args.device ?? "",
			flags: { resume: flags.resume, force: flags.force, user: flags.user },
		});
	}
}
