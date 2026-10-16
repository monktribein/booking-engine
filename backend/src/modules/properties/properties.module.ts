import { Module } from '@nestjs/common';
import { PropertiesController } from './properties.controller';
import { PropertiesService } from './properties.service';
import { PropertyVisibilityController, PropertyVisibilityService } from './visibility.service';

@Module({ controllers: [PropertiesController, PropertyVisibilityController], providers: [PropertiesService, PropertyVisibilityService], exports: [PropertiesService, PropertyVisibilityService] })
export class PropertiesModule {}
