import { readState } from "./services/store";
import { isCloud } from "./config/runtime";
App<IAppOption>({
  globalData: {},
  onLaunch() {
    if (!isCloud()) readState();
  },
});
